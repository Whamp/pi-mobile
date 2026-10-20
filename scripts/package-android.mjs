import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { build } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const generated = join(root, "android/.generated");
const app = join(generated, "app");
await rm(app, { recursive: true, force: true });
await mkdir(app, { recursive: true });
await cp(join(root, "dist/src"), join(app, "src"), { recursive: true, filter: (path) => !/\.(?:map|ts)$/.test(path) });
await cp(join(app, "src/server/static-web.js"), join(app, "src/server/web.js"));
for (const file of ["package.json", "package-lock.json"]) await cp(join(root, file), join(app, file));
execFileSync("npm", ["ci", "--omit=dev", "--ignore-scripts", "--cache", join(root, "android/.cache/npm")], {
	cwd: app,
	stdio: "inherit",
});
await build({
	configFile: false,
	root,
	plugins: [react()],
	envDir: false,
	envPrefix: "PI_MOBILE_PUBLIC_",
	html: { cspNonce: "__P2W_NONCE__" },
	build: { outDir: join(app, "web"), emptyOutDir: true },
});
await cp(join(generated, "assets/cert.pem"), join(app, "cert.pem"));
await cp(join(generated, "assets/runtime-manifest.json"), join(app, "runtime-manifest.json"));
await cp(join(generated, "licenses"), join(app, "licenses"), { recursive: true });
await cp(join(root, "third-party"), join(app, "third-party"), { recursive: true });
await writeFile(join(app, "openssl.cnf"), "openssl_conf = openssl_init\n[openssl_init]\n");
const zip = join(generated, "assets/app.zip");
await rm(zip, { force: true });
execFileSync(process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin/jar") : "jar", [
	"--create",
	"--file",
	zip,
	"--no-manifest",
	"-C",
	app,
	".",
]);
const version = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
await writeFile(join(generated, "assets/app-version.txt"), `${version}-${Date.now()}\n`);
console.log(`Packaged app.zip (${(await readFile(zip)).length} bytes).`);
