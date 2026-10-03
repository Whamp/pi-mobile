import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/biome-check.mjs", import.meta.url));

test("Biome WASM checks formatting, lint, syntax, assists and ignores", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-mobile-biome-"));
	const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8" });
	try {
		assert.equal(spawnSync("git", ["init", "--quiet"], { cwd }).status, 0);
		writeFileSync(
			join(cwd, "biome.json"),
			JSON.stringify({
				formatter: { indentStyle: "tab", lineWidth: 120 },
				linter: { rules: { recommended: true } },
				files: { includes: ["*.ts", "!ignored.ts"] },
			}),
		);
		writeFileSync(join(cwd, "ignored.ts"), "const = broken");
		writeFileSync(join(cwd, "example.ts"), "console.log(  'hello' )");
		assert.equal(run().status, 1);
		assert.equal(run("--write").status, 0);
		assert.equal(run().status, 0);
		writeFileSync(join(cwd, "example.ts"), "debugger;\n");
		const lint = run();
		assert.equal(lint.status, 1);
		assert.match(lint.stderr, /noDebugger/);
		writeFileSync(join(cwd, "example.ts"), "const = broken\n");
		assert.equal(run().status, 1);
		writeFileSync(
			join(cwd, "example.ts"),
			'import { join } from "node:path";\nimport assert from "node:assert/strict";\nconsole.log(join, assert);\n',
		);
		const assist = run();
		assert.equal(assist.status, 1);
		assert.match(assist.stderr, /organizeImports/);
		assert.equal(run("--write").status, 0);
		assert.equal(run().status, 0);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
