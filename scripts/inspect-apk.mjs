import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";

const apk = process.argv[2] ?? "/workspace/badlogic-torture/apk/p2w-debug.apk";
const output = process.argv[3] ?? "/workspace/badlogic-torture/proof/apk";
const sdk = process.env.ANDROID_HOME ?? join(homedir(), "Android/Sdk");
const buildTools = join(sdk, "build-tools/36.0.0");
await mkdir(output, { recursive: true });
const run = (command, args) => execFileSync(command, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
for (const [file, command, args] of [
	["badging.txt", join(buildTools, "aapt2"), ["dump", "badging", apk]],
	["manifest.txt", join(buildTools, "aapt2"), ["dump", "xmltree", apk, "--file", "AndroidManifest.xml"]],
	["signing.txt", join(buildTools, "apksigner"), ["verify", "--verbose", "--print-certs", apk]],
])
	await writeFile(join(output, file), run(command, args));
const entries = run("unzip", ["-Z1", apk]).trim().split("\n");
await writeFile(join(output, "files.txt"), `${entries.join("\n")}\n`);
const abis = [...new Set(entries.filter((path) => path.startsWith("lib/")).map((path) => path.split("/")[1]))].sort();
assert.deepEqual(abis, ["arm64-v8a", "x86_64"]);
for (const abi of abis) assert(entries.includes(`lib/${abi}/libp2w_node.so`));
await writeFile(join(output, "abis.txt"), `${entries.filter((path) => path.startsWith("lib/")).join("\n")}\n`);

const patterns = [
	["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
	["GitHub fine-grained token", /\bgithub_pat_[A-Za-z0-9_]{40,}\b/],
	["Provider secret key", /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{32,}\b/],
	["AWS access key ID", /\bAKIA[0-9A-Z]{16}\b/],
	["Private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
	["Stored OAuth token", /"(?:access_token|refresh_token)"\s*:\s*"[A-Za-z0-9._-]{24,}"/],
];
const temporary = await mkdtemp(join(tmpdir(), "p2w-apk-audit-"));
const scanned = [];
const matches = [];
const publicExamples = [];
try {
	run("unzip", ["-q", apk, "-d", join(temporary, "apk")]);
	run("unzip", ["-q", join(temporary, "apk/assets/app.zip"), "-d", join(temporary, "app")]);
	async function scan(directory, prefix) {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			const label = `${prefix}/${entry.name}`;
			if (entry.isDirectory()) {
				await scan(path, label);
				continue;
			}
			const content = await readFile(path);
			scanned.push({ path: label, bytes: content.length });
			if (
				/^(auth\.json|owner-key|owner-token\.txt|device\.json|id_rsa|id_ed25519|\.env)$/.test(basename(path)) ||
				/\.sqlite(?:-wal|-shm)?$/.test(path)
			)
				matches.push({ path: label, pattern: "Runtime credential or session file" });
			let text = content.toString("latin1");
			if (text.includes("AKIAIOSFODNN7EXAMPLE")) {
				publicExamples.push({
					path: label,
					value: "AKIAIOSFODNN7EXAMPLE",
					reason: "AWS's published documentation example, not an account credential",
				});
				text = text.replaceAll("AKIAIOSFODNN7EXAMPLE", "");
			}
			for (const [name, pattern] of patterns) if (pattern.test(text)) matches.push({ path: label, pattern: name });
		}
	}
	await scan(join(temporary, "apk"), "apk");
	await scan(join(temporary, "app"), "app");
	const result = {
		apk,
		bytes: (await stat(apk)).size,
		sha256: createHash("sha256")
			.update(await readFile(apk))
			.digest("hex"),
		abis,
		package: "dev.whamp.p2w",
		signing: "Android debug certificate; see signing.txt",
		patterns: patterns.map(([name, pattern]) => ({ name, pattern: String(pattern) })),
		scannedFiles: scanned.length,
		scanned,
		matches,
		publicExamples,
		limitations:
			"Pattern scan and explicit clean staging; this is not a proof against every possible secret encoding. No host credential files were read or copied.",
	};
	await writeFile(join(output, "secret-scan.json"), `${JSON.stringify(result, null, 2)}\n`);
	assert.equal(
		matches.length,
		0,
		`Potential credentials found; inspect redacted matches in ${output}/secret-scan.json`,
	);
	console.log(
		JSON.stringify({
			apk,
			bytes: result.bytes,
			sha256: result.sha256,
			abis,
			scannedFiles: scanned.length,
			matches: 0,
		}),
	);
} finally {
	await rm(temporary, { recursive: true, force: true });
}
