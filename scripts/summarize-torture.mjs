import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const directory = process.env.P2W_PROOF_DIR ?? "/workspace/badlogic-torture/proof/torture";
const rows = [];
async function visit(path, label = "") {
	const names = await readdir(path, { withFileTypes: true });
	if (names.some((entry) => entry.name === "events.jsonl")) {
		const events = (await readFile(join(path, "events.jsonl"), "utf8"))
			.trim()
			.split("\n")
			.filter(Boolean)
			.map(JSON.parse);
		const result = await readFile(join(path, "results.json"), "utf8")
			.then(JSON.parse)
			.catch(() => undefined);
		const failure = await readFile(join(path, "failure.json"), "utf8")
			.then(JSON.parse)
			.catch(() => undefined);
		const kill = events.find((event) => event.type === "kill");
		const continued = events.find(
			(event) =>
				event.type === "nested-tool" &&
				event.status === "running" &&
				event.arguments?.command?.includes('echo "4 '),
		);
		const lines = result?.log.trim().split("\n") ?? [];
		const counts = Array.from(
			{ length: 12 },
			(_, index) => lines.filter((line) => line.startsWith(`${index + 1} `)).length,
		);
		const row = {
			path: label,
			method: result?.method ?? events[0]?.method,
			sleep: result?.sleepSeconds,
			pass: result ? Object.values(result.verdict).every(Boolean) : false,
			interruptedStep: result?.interruptedStep ?? kill?.interruptedStep,
			step3Logged: result ? counts[2] === 1 : undefined,
			duplicates: result ? counts.filter((count) => count > 1).length : undefined,
			resumeLatencyMs: kill && continued ? Date.parse(continued.at) - Date.parse(kill.at) : undefined,
			error: failure?.error,
			workerErrors: failure?.workers,
			results: result?.results,
		};
		rows.push(row);
		if (failure)
			console.log(
				label,
				JSON.stringify({
					workers: failure.workers,
					lastEntries: failure.view?.[0]?.entries?.slice(-1),
					live: failure.view?.[0]?.docs?.["pi.live"],
				}),
			);
	}
	for (const entry of names)
		if (entry.isDirectory()) await visit(join(path, entry.name), label ? `${label}/${entry.name}` : entry.name);
}
await visit(directory);
let markdown =
	"# Codemode restart proof\n\nEvery successful run interrupts bash call 3, retains one submission in conversation 1, resumes calls 4–12 and final cat, and passes P1–P4. Calls have no script timeout.\n\n";
markdown +=
	"| Bundle | Method | Sleep s | Pass | Interrupted | Step 3 line | Duplicates | Resume to call 4 ms |\n|---|---|---:|---|---:|---|---:|---:|\n";
for (const row of rows)
	markdown += `| ${row.path} | ${row.method} | ${row.sleep ?? "unknown"} | ${row.pass ? "PASS" : "FAIL"} | ${row.interruptedStep ?? "before kill"} | ${row.step3Logged ?? "unknown"} | ${row.duplicates ?? "unknown"} | ${row.resumeLatencyMs ?? "unknown"} |\n`;
markdown +=
	"\nWorker-only SIGKILL may leave its separately grouped shell alive: step 3 can append once even though its durable result reports interruption. No external effect is promised exactly once. Android force-stop kills the app's processes, including children; reopening is required. No unsafe orphan reaping is attempted.\n\nEarlier failed attempts are retained, including the IPC snapshot race fixed in db09022 and attempts that timed out before observing call 3. A failed attempt is never counted as a pass. Events use host wall-clock timestamps; resume latency includes shutdown/startup and observer polling.\n";
await writeFile(join(directory, "SUMMARY.md"), markdown);
await writeFile(join(directory, "summary.json"), JSON.stringify(rows, null, 2));
console.log(JSON.stringify(rows.map(({ path, pass, error }) => ({ path, pass, error }))));
