import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/server/app.ts";
import type { SessionSummary } from "../src/shared/protocol.ts";
import { Client, until } from "./client.ts";

// A real parent-process crash exercises IPC disconnect cleanup and the kernel
// ownership locks, unlike just calling the app's orderly close method.
test(
	"server SIGKILL leaves work durable and replacement workers never overlap owners",
	// Credential locks keep Pi's 30-second stale-owner window after SIGKILL.
	{ timeout: 90_000 },
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "mobile-server-crash-"));
		const child = spawn(process.execPath, [fileURLToPath(new URL("../src/server/main.ts", import.meta.url))], {
			env: {
				...process.env,
				PORT: "0",
				PI_MOBILE_DATA_DIR: directory,
				PI_MOBILE_FAKE: "1",
				PI_MOBILE_PROVIDER: "",
				PI_MOBILE_MODEL: "",
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		const exited = new Promise<void>((done) => child.once("exit", () => done()));
		let app: Awaited<ReturnType<typeof createApp>> | undefined;
		let client: Client | undefined;
		try {
			let output = "";
			child.stdout.on("data", (chunk: Buffer) => {
				output += chunk.toString();
			});
			child.stderr.on("data", () => {});
			await until(() => /http:\/\/127\.0\.0\.1:\d+/.test(output));
			const url = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
			assert(url);
			client = await Client.connect(url);
			const session = await client.request<SessionSummary>({ type: "create", cwd: directory });
			await client.request({ type: "open", sessionId: session.id });
			await client.request({
				type: "prompt",
				sessionId: session.id,
				content: "slow servercrashword",
				requestId: "crash",
			});
			const firstClient = client;
			await until(() =>
				firstClient.events.some(
					(event) => event.type === "view" && JSON.stringify(event.ops).includes("streaming"),
				),
			);
			child.kill("SIGKILL");
			await exited;
			await client.close();
			client = undefined;

			app = await createApp({ directory, fake: true });
			assert.equal(app.workers.status(session.id).running, false);
			await app.workers.open(session.id);
			assert.notEqual(app.workers.status(session.id).pid, session.worker.pid);
			const replacement = app;
			await until(() =>
				replacement.catalog
					.search("servercrashword")
					.messages.some((message) => message.role === "assistant" && message.text.length > 2000),
			);
			const view = await app.workers.attach("test", session.id, 1);
			app.workers.unview("test");
			assert.equal(view.entries.filter((entry) => entry.kind === "pi.user").length, 1);
			assert(
				view.entries.some((entry) =>
					entry.model?.some((message) => message.role === "assistant" && message.stopReason === "stop"),
				),
			);
			await Promise.all([app.workers.stop(session.id), app.workers.open(session.id)]);
			assert(app.workers.status(session.id).running);
			await app.workers.command(session.id, { type: "prompt", content: "slow shutdownword", requestId: "shutdown" });
			await until(() => replacement.workers.status(session.id).tasks > 0);
			const closeStart = Date.now();
			await app.close();
			app = undefined;
			app = await createApp({ directory, fake: true });
			assert(
				Date.now() - closeStart < 5000,
				"orderly shutdown must drain auth acquisitions, not leave a stale lock",
			);
			assert.equal(app.workers.status(session.id).running, false);
			await app.workers.open(session.id);
			const reopened = app;
			await until(() =>
				reopened.catalog
					.search("shutdownword")
					.messages.some((message) => message.role === "assistant" && message.text.length > 2000),
			);
		} finally {
			child.kill("SIGKILL");
			await exited;
			await client?.close();
			await app?.close();
			await rm(directory, { recursive: true, force: true });
		}
	},
);
