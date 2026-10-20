import { join } from "node:path";
import { KILL_METHODS, runTorture } from "./torture.ts";

const output = process.env.P2W_PROOF_DIR ?? "/workspace/badlogic-torture/proof/torture";
for (let round = 1; round <= 3; round++) {
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
