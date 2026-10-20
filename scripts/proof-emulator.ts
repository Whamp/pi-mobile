import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import type { LiveState } from "@earendil-works/pi-durable";
import type { SessionSummary } from "../src/shared/protocol.ts";
import { verifyTorture } from "../src/shared/torture.ts";
import { Client, until } from "../test/client.ts";
import { codemodeResult } from "./torture.ts";

const execute = promisify(execFile);
const adb = join(homedir(), "Android/Sdk/platform-tools/adb");
const serial = process.env.P2W_ADB_SERIAL ?? "emulator-5572";
const output = process.env.P2W_EMULATOR_PROOF ?? "/workspace/badlogic-torture/proof/emulator";
const origin = "http://127.0.0.1:18787";
const packageName = "dev.whamp.p2w";
const method = process.argv[2] ?? "node-kill";
const manualService = process.env.P2W_EMULATOR_MANUAL_SERVICE === "1";
assert(["node-kill", "force-stop", "am-kill"].includes(method));
await mkdir(output, { recursive: true });
const events = join(output, `${method}-events.jsonl`);
await writeFile(events, "");
async function command(...args: string[]) {
	await appendFile(events, `${JSON.stringify({ at: new Date().toISOString(), type: "adb-start", args })}\n`);
	const result = await execute(adb, ["-s", serial, ...args], { timeout: 600_000, maxBuffer: 32 * 1024 * 1024 });
	await appendFile(
		events,
		`${JSON.stringify({ at: new Date().toISOString(), type: "adb-done", args, stdout: result.stdout })}\n`,
	);
	return result.stdout;
}
async function screenshot(name: string) {
	const result = await execute(adb, ["-s", serial, "exec-out", "screencap", "-p"], {
		encoding: "buffer",
		timeout: 600_000,
		maxBuffer: 32 * 1024 * 1024,
	});
	await writeFile(join(output, name), result.stdout);
}
async function healthy() {
	for (let attempt = 0; attempt < 600; attempt++) {
		try {
			if ((await fetch(`${origin}/health`, { signal: AbortSignal.timeout(10000) })).ok) return;
		} catch {}
		await delay(2000);
	}
	throw new Error("Android server did not become healthy");
}

let client: Client | undefined;
let heartbeat: ReturnType<typeof setInterval> | undefined;
let monitor: ReturnType<typeof setInterval> | undefined;
try {
	await command("forward", "tcp:18787", "tcp:18787");
	await healthy();
	const appVersion = (await command("shell", "run-as", packageName, "cat", "files/app/.installed-version")).trim();
	const activityPid = (await command("shell", "pidof", packageName)).trim();
	assert(/^\d+$/.test(activityPid));
	client = await Client.connect(origin, 1800_000);
	const runId = `${method}-${randomUUID()}`;
	const session = await client.request<SessionSummary>({ type: "create", cwd: "~", title: `Android ${method}` });
	assert.equal(session.model.provider, "faux", "Android proof must explicitly enable the debug fake provider first");
	await client.request({ type: "open", sessionId: session.id });
	const worker = client.workers.get(session.id)?.pid;
	assert(worker);
	const stat = await command("shell", "run-as", packageName, "cat", `/proc/${worker}/stat`);
	const nodePid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
	assert(Number.isInteger(nodePid) && nodePid > 1);
	const submission = await client.request({
		type: "prompt",
		sessionId: session.id,
		content: `torture ${runId}`,
		requestId: runId,
	});
	heartbeat = setInterval(() => {
		if (client?.socket.readyState === 1)
			void client.request({ type: "heartbeat", sessionId: session.id }).catch(() => {});
	}, 10000);
	const seen = new Map<string, string>();
	monitor = setInterval(() => {
		const live = client?.views.get(session.id)?.docs["pi.live"] as unknown as LiveState | undefined;
		for (const call of live?.nestedTools ?? []) {
			const serialized = JSON.stringify(call);
			if (seen.get(call.callId) === serialized) continue;
			seen.set(call.callId, serialized);
			void appendFile(events, `${JSON.stringify({ at: new Date().toISOString(), type: "nested-tool", ...call })}\n`);
		}
	}, 50);
	await until(() => {
		const live = client?.views.get(session.id)?.docs["pi.live"] as unknown as LiveState | undefined;
		return (
			live?.nestedTools?.some(
				(call) =>
					call.status === "running" &&
					typeof call.arguments.command === "string" &&
					call.arguments.command.includes('echo "3 '),
			) ?? false
		);
	}, 1200_000);
	const before = client.views.get(session.id);
	assert.equal(client.workers.get(session.id)?.pid, worker, "Worker changed before the scheduled kill");
	await appendFile(
		events,
		`${JSON.stringify({ at: new Date().toISOString(), type: "kill", method, nodePid, worker, sessionId: session.id, submission })}\n`,
	);
	if (method === "node-kill") await command("shell", "run-as", packageName, "/system/bin/kill", "-9", String(nodePid));
	else if (method === "force-stop") {
		await command("shell", "am", "force-stop", packageName);
		await command("shell", "am", "start", "-n", `${packageName}/.MainActivity`, "--ez", "fake", "true");
		if (manualService)
			await command(
				"shell",
				"run-as",
				packageName,
				"am",
				"start-foreground-service",
				"--user",
				"0",
				"-n",
				`${packageName}/.RuntimeService`,
			);
	} else {
		await command("shell", "input", "keyevent", "KEYCODE_HOME");
		await command("shell", "am", "kill", packageName);
	}
	if (method !== "am-kill") {
		await client.close();
		await healthy();
		client = await Client.connect(origin, 1800_000);
		await client.request({ type: "open", sessionId: session.id });
	}
	await until(() => codemodeResult(client?.views.get(session.id)) !== undefined, 2400_000);
	const view = client.views.get(session.id);
	assert(view);
	const result = codemodeResult(view);
	assert(result);
	const users = view.entries.filter((entry) => entry.kind === "pi.user");
	const same =
		users.length === 1 &&
		users[0].id === before?.entries.find((entry) => entry.kind === "pi.user")?.id &&
		view.conversation.id === before?.conversation.id;
	const verdict = verifyTorture(result.value, same);
	if (method !== "am-kill") assert(Object.values(verdict).every(Boolean), JSON.stringify(verdict));
	else
		assert(
			same && result.value.results.every((row, index) => row === `${index + 1}: ok`),
			"am kill must leave foreground work running",
		);
	assert.equal(result.calls.length, 14);
	const actual = await command(
		"shell",
		"run-as",
		packageName,
		"cat",
		`files/tmp/durable-codemode/restart-${runId}.log`,
	);
	assert.equal(result.value.log.replaceAll("\r\n", "\n"), actual.replaceAll("\r\n", "\n"));
	const newWorker = client.workers.get(session.id)?.pid;
	assert(newWorker);
	const newStat = await command("shell", "run-as", packageName, "cat", `/proc/${newWorker}/stat`);
	const newNodePid = Number(newStat.slice(newStat.lastIndexOf(")") + 2).split(" ")[1]);
	assert(Number.isInteger(newNodePid) && newNodePid > 1);
	const newActivityPid = (await command("shell", "pidof", packageName)).trim();
	assert(/^\d+$/.test(newActivityPid));
	if (method === "node-kill") {
		assert.notEqual(newNodePid, nodePid, "The foreground service must launch a replacement Node process");
		assert.equal(newActivityPid, activityPid, "Node recovery must preserve the Android service process");
	}
	if (method === "force-stop") {
		assert.notEqual(newNodePid, nodePid);
		assert.notEqual(newActivityPid, activityPid);
	}
	const proof = {
		serial,
		appVersion,
		manualService,
		method,
		runId,
		sessionId: session.id,
		conversationId: view.conversation.id,
		submission,
		nodePid,
		newNodePid,
		activityPid,
		newActivityPid,
		oldWorker: worker,
		newWorker,
		verdict,
		...result.value,
		calls: result.calls,
	};
	await writeFile(join(output, `${method}-results.json`), JSON.stringify(proof, null, 2));
	await writeFile(join(output, `${method}-restart.log`), actual);
	await writeFile(
		join(output, `${method}-services.txt`),
		await command("shell", "dumpsys", "-t", "120", "activity", "services", packageName),
	);
	await screenshot(`${method}-completed.png`);
	console.log(JSON.stringify(proof));
} finally {
	clearInterval(heartbeat);
	clearInterval(monitor);
	await client?.close();
}
