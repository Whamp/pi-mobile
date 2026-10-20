import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { ConversationView, LiveState } from "@earendil-works/pi-durable";
import type { CodemodeToolDetails } from "@earendil-works/pi-durable/codemode";
import type { SessionSummary } from "../src/shared/protocol.ts";
import { type TortureResult, verifyTorture } from "../src/shared/torture.ts";
import { Client, until } from "../test/client.ts";

export const KILL_METHODS = ["K1", "K2", "K3", "K3b", "K-pg"] as const;
export type KillMethod = (typeof KILL_METHODS)[number];

function killOwned(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(pid, signal);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
}

export function codemodeResult(view: ConversationView | undefined) {
	for (const entry of view?.entries ?? []) {
		for (const message of entry.model ?? []) {
			if (message.role !== "toolResult" || message.toolName !== "codemode") continue;
			assert(!message.isError, JSON.stringify(message.content));
			const output = message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
			return {
				value: JSON.parse(output.slice(output.indexOf("{", output.indexOf("Output:")))) as TortureResult,
				calls: (message.details as CodemodeToolDetails).calls,
			};
		}
	}
	return undefined;
}

async function descendants(root: number): Promise<{ pid: number; parent: number; group: number }[]> {
	const owned: { pid: number; parent: number; group: number }[] = [];
	async function visit(pid: number) {
		let children: string;
		try {
			const stat = await readFile(`/proc/${pid}/stat`, "utf8");
			const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
			owned.push({ pid, parent: Number(fields[1]), group: Number(fields[2]) });
			children = await readFile(`/proc/${pid}/task/${pid}/children`, "utf8");
		} catch {
			return;
		}
		for (const child of children.trim().split(/\s+/).filter(Boolean)) await visit(Number(child));
	}
	await visit(root);
	return owned;
}

export async function runTorture(method: KillMethod, outputDirectory: string, sleepSeconds = 0.5) {
	await mkdir(outputDirectory, { recursive: true });
	const directory = await mkdtemp(join(tmpdir(), "p2w-torture-"));
	const runId = randomUUID();
	const requestId = `torture-${runId}`;
	const eventsPath = join(outputDirectory, "events.jsonl");
	await writeFile(eventsPath, "");
	const event = (type: string, data: Record<string, unknown> = {}) => {
		void appendFile(eventsPath, `${JSON.stringify({ at: new Date().toISOString(), type, method, ...data })}\n`);
	};
	let server: ChildProcess | undefined;
	let serverExit: Promise<void> | undefined;
	let client: Client | undefined;
	let monitor: ReturnType<typeof setInterval> | undefined;
	let heartbeat: ReturnType<typeof setInterval> | undefined;
	let serverLog = "";
	const knownProcesses = new Set<number>();
	const observedCalls = new Map<string, string>();
	let observedWorker = "";
	const start = async () => {
		let boot = "";
		server = spawn(process.execPath, [fileURLToPath(new URL("../src/server/main.ts", import.meta.url))], {
			detached: true,
			env: {
				...process.env,
				PORT: "0",
				TMPDIR: directory,
				PI_MOBILE_DATA_DIR: directory,
				PI_MOBILE_FAKE: "1",
				PI_MOBILE_PROVIDER: "",
				PI_MOBILE_MODEL: "",
				PI_MOBILE_PROFILE: "",
				PI_MOBILE_WEB: "0",
				PI_MOBILE_TORTURE_SLEEP: String(sleepSeconds),
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		serverExit = new Promise<void>((done) => server?.once("exit", () => done()));
		server.stdout?.on("data", (chunk: Buffer) => {
			boot += chunk.toString();
			serverLog += chunk.toString();
		});
		server.stderr?.on("data", (chunk: Buffer) => {
			serverLog += chunk.toString();
		});
		await until(() => /http:\/\/127\.0\.0\.1:\d+/.test(boot), 30_000);
		const url = boot.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
		assert(url);
		event("server-start", { pid: server.pid, url });
		client = await Client.connect(url);
	};
	try {
		await start();
		assert(client);
		const session = await client.request<SessionSummary>({ type: "create", cwd: directory });
		const id = session.id;
		heartbeat = setInterval(() => {
			const current = client;
			if (!current || current.socket.readyState !== 1) return;
			void current.request({ type: "heartbeat", sessionId: id }).catch(async () => {
				if (current !== client || current.socket.readyState !== 1) return;
				event("viewer-reattach", { sessionId: id });
				await current.request({ type: "open", sessionId: id }).catch(() => {});
			});
		}, 10_000);
		await client.request({ type: "open", sessionId: id });
		const submitted = await client.request<{ submissionId: number }>({
			type: "prompt",
			sessionId: id,
			content: `torture ${runId}`,
			requestId,
		});
		event("submitted", { sessionId: id, conversationId: 1, requestId, ...submitted });
		monitor = setInterval(() => {
			const worker = client?.workers.get(id);
			const serializedWorker = JSON.stringify(worker);
			if (serializedWorker && observedWorker !== serializedWorker) {
				observedWorker = serializedWorker;
				event("worker", { status: worker });
			}
			const live = client?.views.get(id)?.docs["pi.live"] as unknown as LiveState | undefined;
			for (const slot of live?.nestedTools ?? []) {
				const serialized = JSON.stringify(slot);
				if (observedCalls.get(slot.callId) === serialized) continue;
				observedCalls.set(slot.callId, serialized);
				event("nested-tool", { ...slot, workerPid: client?.workers.get(id)?.pid });
			}
		}, 10);
		await until(
			() => {
				const worker = client?.workers.get(id);
				if (worker?.error && !worker.running) throw new Error(worker.error);
				const live = client?.views.get(id)?.docs["pi.live"] as unknown as LiveState | undefined;
				return (
					live?.nestedTools?.some(
						(slot) =>
							slot.name === "bash" &&
							slot.status === "running" &&
							typeof slot.arguments.command === "string" &&
							slot.arguments.command.includes('echo "3 '),
					) ?? false
				);
			},
			Math.max(60_000, sleepSeconds * 5000 + 60_000),
		);
		assert(server?.pid);
		const tree = await descendants(server.pid);
		for (const item of tree) knownProcesses.add(item.pid);
		const workerPid = client.workers.get(id)?.pid;
		assert(workerPid);
		const before = await readFile(join(directory, "durable-codemode", `restart-${runId}.log`), "utf8");
		assert.equal(before.trim().split("\n").length, 3, "kill only after setup and steps 1 and 2");
		const viewBefore = client.views.get(id);
		const userBefore = viewBefore?.entries.find((entry) => entry.kind === "pi.user");
		assert(userBefore);
		event("kill", { serverPid: server.pid, workerPid, tree, interruptedStep: 3, before });
		if (method === "K1") {
			await client.request({ type: "archive", sessionId: id });
			await client.request({ type: "restore", sessionId: id });
		} else if (method === "K2") {
			process.kill(workerPid, "SIGKILL");
			await until(() => client?.workers.get(id)?.running === false);
		} else {
			if (method === "K3b") server.kill("SIGTERM");
			else if (method === "K-pg") {
				for (const group of new Set(tree.map((item) => item.group))) {
					assert(group > 0 && group !== process.pid);
					try {
						process.kill(-group, "SIGKILL");
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
					}
				}
			} else {
				for (const item of tree)
					try {
						process.kill(item.pid, "SIGKILL");
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
					}
			}
			await serverExit;
			await client.close();
			await start();
			assert(client);
		}
		await client.request({ type: "open", sessionId: id });
		event("reopened", { sessionId: id, conversationId: 1, workerPid: client.workers.get(id)?.pid });
		await until(
			() => codemodeResult(client?.views.get(id)) !== undefined,
			Math.max(180_000, sleepSeconds * 12000 + 180_000),
		);
		const view = client.views.get(id);
		assert(view);
		const completed = codemodeResult(view);
		assert(completed);
		const after = await readFile(join(directory, "durable-codemode", `restart-${runId}.log`), "utf8");
		assert.equal(completed.value.log, after, "final cat returns the actual shell log");
		assert(after.startsWith(before), "completed steps 1 and 2 remain byte-for-byte unchanged");
		assert.equal(completed.calls.length, 14, "setup, twelve steps, and final cat");
		assert.equal(completed.calls.at(-1)?.status, "ok");
		const users = view.entries.filter((entry) => entry.kind === "pi.user");
		const verdict = verifyTorture(
			completed.value,
			users.length === 1 &&
				users[0].id === userBefore.id &&
				users[0].conversationId === userBefore.conversationId &&
				view.conversation.id === 1 &&
				view.conversation.id === viewBefore?.conversation.id,
		);
		const proof = {
			method,
			runId,
			sessionId: id,
			conversationId: view.conversation.id,
			requestId,
			submissionId: submitted.submissionId,
			sleepSeconds,
			interruptedStep: 3,
			verdict,
			...completed.value,
			calls: completed.calls,
		};
		await writeFile(join(outputDirectory, "results.json"), `${JSON.stringify(proof, null, 2)}\n`);
		await writeFile(join(outputDirectory, "restart.log"), after);
		await writeFile(
			join(outputDirectory, "verdict.txt"),
			`${Object.entries(verdict)
				.map(([key, value]) => `${key}: ${value ? "PASS" : "FAIL"}`)
				.join("\n")}\n`,
		);
		event("completed", proof);
		assert(Object.values(verdict).every(Boolean), JSON.stringify(verdict));
		console.log(`${method}: ${JSON.stringify(verdict)} (${sleepSeconds}s sleeps, ${id})`);
		return proof;
	} catch (error) {
		event("failure", { error: String(error) });
		await writeFile(
			join(outputDirectory, "failure.json"),
			JSON.stringify(
				{
					error: String(error),
					workers: client ? [...client.workers.entries()] : [],
					view: client ? [...client.views.values()] : [],
				},
				null,
				2,
			),
		);
		throw error;
	} finally {
		clearInterval(monitor);
		clearInterval(heartbeat);
		await client?.close();
		if (server?.pid) for (const item of await descendants(server.pid)) knownProcesses.add(item.pid);
		server?.kill("SIGTERM");
		await Promise.race([serverExit, delay(4000)]);
		for (const pid of knownProcesses) killOwned(pid, "SIGKILL");
		await writeFile(join(outputDirectory, "server.log"), serverLog);
		await rm(directory, { recursive: true, force: true });
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const requested = process.argv[process.argv.indexOf("--kill") + 1];
	const methods =
		requested && KILL_METHODS.includes(requested as KillMethod) ? [requested as KillMethod] : KILL_METHODS;
	const output = process.env.P2W_PROOF_DIR ?? "/workspace/badlogic-torture/proof/torture";
	for (const method of methods)
		await runTorture(method, join(output, method), Number(process.env.PI_MOBILE_TORTURE_SLEEP ?? "0.5"));
}
