import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KILL_METHODS, runTorture } from "../scripts/torture.ts";

for (const method of KILL_METHODS) {
	test(`durable codemode resumes step 4 after ${method} interrupts step 3`, { timeout: 120_000 }, async () => {
		const proof = await mkdtemp(join(tmpdir(), "p2w-torture-proof-"));
		try {
			await runTorture(method, proof);
		} finally {
			await rm(proof, { recursive: true, force: true });
		}
	});
}
