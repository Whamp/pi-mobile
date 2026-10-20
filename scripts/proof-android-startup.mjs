import assert from "node:assert/strict";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const output = process.env.P2W_EMULATOR_PROOF ?? "/workspace/badlogic-torture/proof/emulator/5572";
const launch = process.argv[2];
const timeoutMs = Number(process.env.P2W_STARTUP_TIMEOUT_MS ?? 40 * 60 * 1000);
assert(Number.isFinite(timeoutMs) && timeoutMs > 0);
assert(launch, "Pass the redirected adb Activity-launch transcript to measure from its creation time");
const started = (await stat(launch)).birthtimeMs;
assert(started > 0);
await mkdir(output, { recursive: true });
let attempts = 0;
let lastError;
let healthyAt;
while (Date.now() - started < timeoutMs) {
	attempts++;
	try {
		const response = await fetch("http://127.0.0.1:18787/health", { signal: AbortSignal.timeout(60000) });
		if (response.ok) {
			healthyAt = Date.now();
			break;
		}
		lastError = `HTTP ${response.status}`;
	} catch (error) {
		lastError = String(error);
	}
	if (attempts % 15 === 0)
		console.log(`Waiting for phone-local health: ${Math.round((Date.now() - started) / 1000)}s`);
	await delay(2000);
}
const proof = {
	launch,
	startedAt: new Date(started).toISOString(),
	healthyAt: healthyAt && new Date(healthyAt).toISOString(),
	elapsedMs: (healthyAt ?? Date.now()) - started,
	attempts,
	timeoutMs,
	lastError,
};
await writeFile(join(output, "first-launch-health.json"), JSON.stringify(proof, null, 2));
console.log(JSON.stringify(proof));
assert(healthyAt, `Phone-local server did not become healthy within ${timeoutMs / 60000} minutes`);
