import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	CompactionTask,
	createRegistry,
	defineExtension,
	defineTask,
	Harness,
	hook,
	UserEntry,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { WebSocket } from "ws";
import { createApp } from "../src/server/app.ts";
import { createMobileModels } from "../src/shared/models.ts";
import type { SearchResults, SessionSummary } from "../src/shared/protocol.ts";
import { Client, until } from "./client.ts";

async function listen(app: Awaited<ReturnType<typeof createApp>>): Promise<string> {
	await new Promise<void>((done) => app.http.listen(0, "127.0.0.1", done));
	const address = app.http.address();
	assert(address && typeof address !== "string");
	return `http://127.0.0.1:${address.port}`;
}

function answered(client: Client, id: string, text: string): boolean {
	return (
		client.views
			.get(id)
			?.entries.some(
				(entry) =>
					entry.kind === "pi.assistant" &&
					entry.model?.some(
						(message) =>
							message.role === "assistant" &&
							message.stopReason === "stop" &&
							message.content.some((part) => part.type === "text" && part.text.includes(text)),
					),
			) ?? false
	);
}

test(
	"WebSocket sessions stream tools, recover killed work, preserve search and archive lazily",
	{ timeout: 60_000 },
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "mobile-integration-"));
		let app = await createApp({ directory, fake: true });
		let client: Client | undefined;
		try {
			let url = await listen(app);
			client = await Client.connect(url);
			const current = client;
			assert.equal((await current.request<SessionSummary[]>({ type: "list" })).length, 0);
			await assert.rejects(createApp({ directory, fake: true }), /EADDRINUSE/);
			const workspace = join(directory, "project");
			const session = await current.request<SessionSummary>({
				type: "create",
				cwd: workspace,
				createDirectory: true,
			});
			assert(session.worker.running);
			await writeFile(join(workspace, "fixture.txt"), "private-tool-output-sentinel\n");
			await current.request({ type: "open", sessionId: session.id });
			await current.request({ type: "pin", sessionId: session.id, pinned: true });
			const first = await current.request<{ submissionId: number }>({
				type: "prompt",
				sessionId: session.id,
				content: "tool",
				requestId: "first",
			});
			const duplicate = await current.request<{ submissionId: number }>({
				type: "prompt",
				sessionId: session.id,
				content: "tool",
				requestId: "first",
			});
			assert.equal(duplicate.submissionId, first.submissionId);
			await until(() => answered(current, session.id, "Echo: tool"));
			await until(() => app.catalog.search("Reading").messages.length === 1);
			assert.equal(app.catalog.get(session.id).title, "tool");
			assert.equal(app.catalog.search("private-tool-output-sentinel").messages.length, 0);
			assert.equal(app.catalog.search("private-thinking-sentinel").messages.length, 0);
			assert(current.views.get(session.id)?.entries.some((entry) => entry.kind === "pi.tool-result"));
			assert(current.events.some((event) => event.type === "view" && event.ops.length > 0));
			// In-session model/thinking change: committed to pi.agent and the catalog.
			await current.request({
				type: "configure",
				sessionId: session.id,
				model: { provider: "faux", modelId: "faux-1" },
				thinkingLevel: "high",
			});
			await until(() => current.views.get(session.id)?.docs["pi.agent"]?.thinkingLevel === "high");
			assert.equal(app.catalog.get(session.id).thinkingLevel, "high");
			await assert.rejects(
				current.request({
					type: "configure",
					sessionId: session.id,
					model: { provider: "faux", modelId: "missing" },
				}),
				/Unknown model/,
			);
			await current.request({ type: "rename", sessionId: session.id, title: "My project" });
			await current.request({
				type: "prompt",
				sessionId: session.id,
				content: "slow recoveryword",
				requestId: "recover",
			});
			await until(() => Boolean(current.views.get(session.id)?.docs["pi.live"]?.generation));
			await until(() =>
				current.events.some((event) => event.type === "view" && JSON.stringify(event.ops).includes("streaming")),
			);
			const oldPid = app.workers.status(session.id).pid;
			assert(oldPid);
			process.kill(oldPid, "SIGKILL");
			await until(() => !app.workers.status(session.id).running);
			await current.request({ type: "open", sessionId: session.id });
			assert.notEqual(app.workers.status(session.id).pid, oldPid);
			await until(() => answered(current, session.id, "Echo: slow recoveryword"));
			await until(() => app.catalog.search("recoveryword").messages.length >= 2);
			const users = current.views.get(session.id)?.entries.filter((entry) => entry.kind === "pi.user");
			assert.equal(users?.length, 2, "kill/reopen does not duplicate input");
			await current.request({ type: "reset", sessionId: session.id });
			await until(() => current.views.get(session.id)?.entries[0]?.kind === "pi.reset");
			await current.request({ type: "archive", sessionId: session.id });
			assert.equal(app.workers.status(session.id).running, false);
			assert.equal((await current.request<SessionSummary[]>({ type: "list" })).length, 0);
			const archivedSearch = await current.request<SearchResults>({
				type: "search",
				query: "recoveryword",
				archived: true,
			});
			assert(archivedSearch.messages.length >= 2);
			await current.request({ type: "rebuildIndex", sessionId: session.id });
			assert.equal(app.workers.status(session.id).running, false);
			assert(app.catalog.search("recoveryword", true).messages.length >= 2, "rebuild includes pre-reset history");
			await current.request({ type: "restore", sessionId: session.id });
			assert.equal(app.workers.status(session.id).running, false);
			await current.close();
			client = undefined;
			await app.close();
			app = await createApp({ directory, fake: true });
			url = await listen(app);
			assert.equal(app.workers.status(session.id).running, false, "server restart starts no workers");
			client = await Client.connect(url);
			const restored = await client.request<SessionSummary[]>({ type: "list" });
			assert.equal(restored[0].title, "My project");
			assert(restored[0].pinned);
			assert(app.catalog.search("recoveryword").messages.length >= 2);
			await client.request({ type: "open", sessionId: session.id });
		} finally {
			await client?.close();
			await app.close();
			await rm(directory, { recursive: true, force: true });
		}
	},
);

test(
	"viewer leases and all live tasks protect workers; disconnect doesn't stop work",
	{ timeout: 40_000 },
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "mobile-lifecycle-"));
		const app = await createApp({ directory, fake: true, idleMs: 150, heartbeatMs: 120 });
		let client: Client | undefined;
		try {
			const url = await listen(app);
			client = await Client.connect(url);
			const session = await client.request<SessionSummary>({ type: "create", cwd: directory });
			await client.request({ type: "open", sessionId: session.id });
			for (let i = 0; i < 5; i++) {
				await client.request({ type: "heartbeat", sessionId: session.id });
				await delay(60);
				assert(app.workers.status(session.id).running);
			}
			await client.request({
				type: "prompt",
				sessionId: session.id,
				content: "slow disconnectword",
				requestId: "disconnect",
			});
			await until(() => app.workers.status(session.id).tasks > 0);
			await client.close();
			client = undefined;
			await delay(400);
			assert(app.workers.status(session.id).running);
			await until(() => !app.workers.status(session.id).running);
			assert(app.catalog.search("disconnectword").messages.some((message) => message.role === "assistant"));

			// Seed a real Durable background task while stopped. Its missing definition
			// makes it blocked, but it is still live and must prevent idle shutdown.
			const background = defineTask<null, { phase: "wait" }, null>({
				name: "test.background",
				version: 1,
				initial: () => ({ phase: "wait" }),
				phases: { wait: async () => {} },
				abort: async () => {},
			});
			const registry = createRegistry();
			registry.install(
				defineExtension({
					name: "test.summary",
					hooks: [hook(CompactionTask, { beforeCompact: () => ({ summary: "Compacted fixture history." }) })],
				}),
			);
			const harness = await Harness.open(
				await openNodeSqliteStorage(app.catalog.storagePath(session.id)),
				{
					models: createMobileModels(true),
					registry,
					settings: { compaction: { keepRecentTokens: 100 } },
				},
				BACKGROUND_CONTEXT,
			);
			const root = await harness.root(BACKGROUND_CONTEXT);
			await root.commit(async (tx) => {
				for (let i = 0; i < 225; i++) {
					await tx.appendEntry(UserEntry, root.id, {
						model: [{ role: "user", content: `historicalentry${i}`, timestamp: Date.now() }],
					});
				}
				await tx.createTask(background, null, { ownership: { kind: "conversation" }, background: true });
			}, BACKGROUND_CONTEXT);
			const compacted = await root.compact(undefined, BACKGROUND_CONTEXT);
			assert.equal((await harness.waitForTask(compacted, BACKGROUND_CONTEXT)).state.outcome.status, "completed");
			assert.equal((await root.context(BACKGROUND_CONTEXT)).entries[0]?.kind, "pi.compaction");
			await harness.close(BACKGROUND_CONTEXT);
			await app.workers.open(session.id);
			assert.equal(
				app.catalog.search("historicalentry0").messages.length,
				1,
				"multi-page catch-up includes the oldest entry",
			);
			assert.equal(app.catalog.search("historicalentry224").messages.length, 1);
			assert.equal(app.workers.status(session.id).tasks, 1);
			await delay(400);
			assert(app.workers.status(session.id).running);
			await app.workers.archive(session.id);
			await app.workers.rebuildIndex(session.id);
			assert.equal(app.workers.status(session.id).running, false);
			assert.equal(app.catalog.search("historicalentry0", true).messages.length, 1);
			await app.workers.restore(session.id);
			assert.equal(app.workers.status(session.id).running, false);
			await app.workers.open(session.id);
			assert.equal(app.workers.status(session.id).tasks, 1, "archive preserves unfinished background work");
			await app.workers.command(session.id, { type: "abort", background: true });
			await until(() => !app.workers.status(session.id).running);

			client = await Client.connect(url);
			await client.request({ type: "open", sessionId: session.id });
			await until(() => !app.workers.status(session.id).running, 3000);
		} finally {
			await client?.close();
			await app.close();
			await rm(directory, { recursive: true, force: true });
		}
	},
);

test("WebSocket rejects missing cookies, foreign origins and malformed actions", async () => {
	const directory = await mkdtemp(join(tmpdir(), "mobile-auth-"));
	const app = await createApp({ directory, fake: true });
	let client: Client | undefined;
	try {
		const url = await listen(app);
		const cookie = (await fetch(url)).headers.get("set-cookie")?.split(";")[0];
		for (const headers of [{ Origin: url }, { Cookie: cookie ?? "", Origin: "https://example.com" }]) {
			const socket = new WebSocket(`${url.replace("http:", "ws:")}/ws`, { headers });
			const status = await new Promise<number>((done, reject) => {
				socket.on("error", () => {});
				socket.on("unexpected-response", (_request, response) => {
					response.resume();
					socket.terminate();
					done(response.statusCode ?? 0);
				});
				socket.on("open", () => {
					socket.terminate();
					reject(new Error("Unexpected upgrade"));
				});
			});
			assert.equal(status, 403);
		}
		client = await Client.connect(url);
		await assert.rejects(
			client.request({ type: "prompt", sessionId: "missing", content: "hello", requestId: "test" }),
			/not found/,
		);
		client.socket.send(
			JSON.stringify({ id: "malformed", action: { type: "pin", sessionId: "missing", pinned: "yes" } }),
		);
		const active = client;
		await until(() =>
			active.events.some((event) => event.type === "result" && event.id === "malformed" && Boolean(event.error)),
		);
		assert.equal(app.catalog.list().length, 0);
	} finally {
		await client?.close();
		await app.close();
		await rm(directory, { recursive: true, force: true });
	}
});
