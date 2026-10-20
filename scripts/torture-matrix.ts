import { join } from "node:path";
import { KILL_METHODS, runTorture } from "./torture.ts";

const output = process.env.P2W_PROOF_DIR ?? "/workspace/badlogic-torture/proof/torture";
const first = Number(process.env.P2W_TORTURE_FIRST_ROUND ?? 1);
const rounds = Number(process.env.P2W_TORTURE_ROUNDS ?? 3);
if (!Number.isInteger(first) || first < 1 || !Number.isInteger(rounds) || rounds < 1)
	throw new Error("Torture round counts must be positive integers");
for (let round = first; round < first + rounds; round++) {
	const results = await Promise.allSettled(
		KILL_METHODS.map((method) =>
			runTorture(method, join(output, `${method}-10s${round === 1 ? "" : `-${round}`}`), 10),
		),
	);
	for (const [index, result] of results.entries())
		if (result.status === "rejected") {
			console.error(`${KILL_METHODS[index]} round ${round}: ${String(result.reason)}`);
			process.exitCode = 1;
		}
}
