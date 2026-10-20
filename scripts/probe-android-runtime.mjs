import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const adb = join(homedir(), "Android/Sdk/platform-tools/adb");
const serial = process.env.P2W_ADB_SERIAL ?? "emulator-5572";
const output = process.env.P2W_EMULATOR_PROOF ?? "/workspace/badlogic-torture/proof/emulator";
const run = async (...args) => (await execute(adb, ["-s", serial, ...args], { timeout: 600000 })).stdout;
const apk = (await run("shell", "pm", "path", "dev.whamp.p2w")).trim().replace(/^package:/, "");
assert(/^\/data\/app\/[a-zA-Z0-9_/.=~-]+\/base\.apk$/.test(apk));
const native = `${dirname(apk)}/lib/x86_64`;
const version = await run("shell", "run-as", "dev.whamp.p2w", `${native}/libp2w_node.so`, "--version");
assert.equal(version.trim(), "v24.18.0");
await mkdir(output, { recursive: true });
await writeFile(
	join(output, "native-node-version.json"),
	JSON.stringify({ at: new Date().toISOString(), serial, apk, native, version: version.trim() }, null, 2),
);
console.log(version.trim());
