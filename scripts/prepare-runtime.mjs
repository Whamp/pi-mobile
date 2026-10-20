import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readdir, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const generated = join(root, "android/.generated");
const cache = join(root, "android/.cache/termux");
const lock = JSON.parse(await readFile(join(root, "android/runtime-lock.json"), "utf8"));
const patchelf = process.env.PATCHELF ?? "patchelf";
const run = (command, args) => execFileSync(command, args, { encoding: "utf8" });
const native = [
	["bin/node", "libp2w_node.so"],
	["lib/libz.so.1", "libp2w_z.so"],
	["lib/libcares.so", "libp2w_cares.so"],
	["lib/libsqlite3.so", "libp2w_sqlite.so"],
	["lib/libcrypto.so.3", "libp2w_crypto.so"],
	["lib/libssl.so.3", "libp2w_ssl.so"],
	["lib/libicui18n.so.78", "libp2w_icui18n.so"],
	["lib/libicuuc.so.78", "libp2w_icuuc.so"],
	["lib/libicudata.so.78", "libp2w_icudata.so"],
	["lib/libc++_shared.so", "libp2w_cxx.so"],
];
const rename = new Map(native.slice(1).map(([path, name]) => [basename(path), name]));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function copyNotices(source, target, extracted) {
	const info = await lstat(source);
	if (info.isSymbolicLink()) {
		const link = await readlink(source);
		const resolved = link.startsWith("/") ? join(extracted, link.slice(1)) : resolve(dirname(source), link);
		if (relative(extracted, resolved).startsWith("..")) throw new Error("License symlink escaped package root");
		return copyNotices(resolved, target, extracted);
	}
	if (info.isDirectory()) {
		await mkdir(target, { recursive: true });
		for (const entry of await readdir(source)) await copyNotices(join(source, entry), join(target, entry), extracted);
	} else await copyFile(source, target);
}
await mkdir(cache, { recursive: true });
await mkdir(join(generated, "assets"), { recursive: true });
const manifest = { packages: lock, native: [] };
for (const [architecture, abi] of [
	["aarch64", "arm64-v8a"],
	["x86_64", "x86_64"],
]) {
	const extracted = join(cache, `${architecture}-root`);
	await rm(extracted, { recursive: true, force: true });
	await mkdir(extracted, { recursive: true });
	for (const entry of lock.filter((pkg) => pkg.arch === architecture || pkg.arch === "all")) {
		const archive = join(cache, basename(entry.url));
		let bytes;
		try {
			bytes = await readFile(archive);
		} catch {
			/* Download absent archives. */
		}
		if (!bytes || sha256(bytes) !== entry.sha256) {
			run("curl", ["-fL", "--retry", "3", entry.url, "-o", archive]);
			bytes = await readFile(archive);
		}
		if (sha256(bytes) !== entry.sha256) throw new Error(`SHA-256 mismatch: ${entry.url}`);
		run("dpkg-deb", ["-x", archive, extracted]);
	}
	const prefix = join(extracted, "data/data/com.termux/files/usr");
	const target = join(generated, "jniLibs", abi);
	await rm(target, { recursive: true, force: true });
	await mkdir(target, { recursive: true });
	for (const [source, name] of native) {
		const output = join(target, name);
		await copyFile(await realpath(join(prefix, source)), output);
		const args = ["--page-size", "16384", "--set-rpath", "$ORIGIN"];
		if (source !== "bin/node") args.push("--set-soname", name);
		for (const needed of run(patchelf, ["--print-needed", output]).trim().split("\n")) {
			const replacement = rename.get(needed);
			if (replacement) args.push("--replace-needed", needed, replacement);
		}
		run(patchelf, [...args, output]);
		await chmod(output, 0o755);
		const needed = run(patchelf, ["--print-needed", output]).trim().split("\n").filter(Boolean);
		if (
			needed.some(
				(name) => !native.some(([, file]) => file === name) && !["libc.so", "libm.so", "libdl.so"].includes(name),
			)
		)
			throw new Error(`Unbundled native dependency: ${name}: ${needed}`);
		const elf = run("readelf", ["-lW", output]);
		if (
			elf
				.split("\n")
				.filter((line) => line.trim().startsWith("LOAD"))
				.some((line) => Number(line.trim().split(/\s+/).at(-1)) < 16384)
		)
			throw new Error(`ELF alignment below 16 KiB: ${name}`);
		manifest.native.push({ abi, file: name, sha256: sha256(await readFile(output)), needed });
	}
	if (architecture === "aarch64") {
		await copyFile(await realpath(join(prefix, "etc/tls/cert.pem")), join(generated, "assets/cert.pem"));
		await rm(join(generated, "licenses"), { recursive: true, force: true });
		await copyNotices(join(prefix, "share/doc"), join(generated, "licenses"), extracted);
		// The pinned libicu archive contains a 404 response in place of its notice.
		await copyFile(join(root, "android/licenses/ICU-LICENSE.txt"), join(generated, "licenses/libicu/LICENSE"));
	}
}
await writeFile(join(generated, "assets/runtime-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Prepared ${manifest.native.length} native files from verified Termux archives in ${resolve(generated)}.`);
