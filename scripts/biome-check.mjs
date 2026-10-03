import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { matchesGlob } from "node:path";
import { Biome } from "@biomejs/js-api/nodejs";

// The WASM API has no CLI file scanner. Git supplies tracked and untracked
// files while respecting .gitignore; biome.json supplies the include patterns.
const configuration = JSON.parse(readFileSync("biome.json", "utf8"));
const patterns = configuration.files?.includes ?? ["**"];
const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
	encoding: "utf8",
})
	.split("\0")
	.filter(Boolean)
	.filter((path) => {
		let included = false;
		for (const pattern of patterns) {
			const excluded = pattern.startsWith("!");
			if (matchesGlob(path, pattern.replace(/^!+/, ""))) included = !excluded;
		}
		return included;
	});
const write = process.argv.includes("--write");
const biome = new Biome();
let failures = 0;
let checked = 0;
try {
	const { projectKey } = biome.openProject(process.cwd());
	biome.applyConfiguration(projectKey, configuration);
	for (const filePath of files) {
		const original = readFileSync(filePath, "utf8");
		const lint = biome.lintContent(projectKey, original, {
			filePath,
			...(write ? { fixFileMode: "safeFixes" } : {}),
		});
		const format = biome.formatContent(projectKey, lint.content, { filePath });
		if (write && format.content !== original) writeFileSync(filePath, format.content);
		for (const diagnostic of lint.diagnostics) {
			if (diagnostic.severity === "hint") continue;
			// Biome's WASM build reports its version as 0.0.0. Keep the real
			// schema URL for editors, but ignore only this spurious mismatch.
			if (
				filePath === "biome.json" &&
				diagnostic.category === "deserialize" &&
				diagnostic.description === "The configuration schema version does not match the CLI version 0.0.0"
			)
				continue;
			console.error(`${filePath}: ${diagnostic.severity} ${diagnostic.category ?? ""}: ${diagnostic.description}`);
			failures++;
		}
		if (!write && format.content !== original) {
			console.error(`${filePath}: formatting differs (run npm run format)`);
			failures++;
		}
		checked++;
	}
} finally {
	biome.shutdown();
}
console.log(`Biome WASM: checked ${checked} files; ${failures} diagnostics.`);
if (failures > 0) process.exitCode = 1;
