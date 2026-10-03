import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFile, copyFile, cp, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { SessionSummary } from "../src/shared/protocol.ts";
import { Client, until } from "./client.ts";

test(
	"dev supervisor preserves all running workers and unfinished inputs; web edits stay on HMR",
	{ timeout: 90_000 },
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "mobile-dev-"));
		const project = join(directory, "project");
		await mkdir(join(project, "scripts"), { recursive: true });
		await cp(new URL("../src", import.meta.url), join(project, "src"), { recursive: true });
		for (const name of ["package.json", "index.html"])
			await copyFile(new URL(`../${name}`, import.meta.url), join(project, name));
		await copyFile(new URL("../scripts/dev.mjs", import.meta.url), join(project, "scripts/dev.mjs"));
		await symlink(new URL("../node_modules", import.meta.url).pathname, join(project, "node_modules"));
		const child = spawn(process.execPath, ["scripts/dev.mjs"], {
			cwd: project,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...process.env,
				PORT: "0",
				PI_MOBILE_FAKE: "1",
				PI_MOBILE_DATA_DIR: join(directory, "data"),
				PI_MOBILE_ALLOWED_HOSTS: "",
				PI_MOBILE_PROVIDER: "",
				PI_MOBILE_MODEL: "",
				PI_MOBILE_DEV_RESUME: "[]",
			},
		});
		let log = "";
		child.stdout.on("data", (chunk: Buffer) => {
			log += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			log += chunk.toString();
		});
		const urls = () => [...log.matchAll(/Pi Mobile: (http:\/\/127\.0\.0\.1:\d+)/g)].map((match) => match[1]);
		let client: Client | undefined;
		try {
			await until(() => urls().length === 1, 20_000);
			client = await Client.connect(urls()[0] ?? "");
			const first = await client.request<SessionSummary>({ type: "create", cwd: directory });
			// No browser views the second worker; it must still be restored.
			const second = await client.request<SessionSummary>({ type: "create", cwd: directory });
			await client.request({ type: "open", sessionId: first.id });
			await client.request({
				type: "prompt",
				sessionId: first.id,
				content: "slow dev-resume-sentinel",
				requestId: "durable-input",
			});
			const original = client;
			await until(() => Boolean(original.views.get(first.id)?.docs["pi.live"]?.generation));
			await delay(250);

			// Editing a worker source recycles the backend, not just the visible worker.
			await appendFile(join(project, "src/worker/main.ts"), "\n// dev restart test\n");
			await until(() => urls().length === 2, 20_000);
			await client.close();
			client = await Client.connect(urls()[1] ?? "");
			let sessions: SessionSummary[] = [];
			for (let i = 0; i < 100; i++) {
				sessions = await client.request<SessionSummary[]>({ type: "list" });
				if (
					sessions.every(
						(session) =>
							session.worker.running &&
							session.worker.pid !== (session.id === first.id ? first.worker.pid : second.worker.pid),
					)
				)
					break;
				await delay(100);
			}
			assert.equal(sessions.length, 2);
			assert(sessions.every((session) => session.worker.running));
			assert.notEqual(sessions.find((session) => session.id === first.id)?.worker.pid, first.worker.pid);
			assert.notEqual(sessions.find((session) => session.id === second.id)?.worker.pid, second.worker.pid);
			await client.request({ type: "open", sessionId: first.id });
			const restarted = client;
			await until(
				() =>
					Boolean(
						restarted.views
							.get(first.id)
							?.entries.some((entry) =>
								entry.model?.some(
									(message) =>
										message.role === "assistant" &&
										message.stopReason === "stop" &&
										message.content.some(
											(part) => part.type === "text" && part.text.includes("dev-resume-sentinel"),
										),
								),
							),
					),
				20_000,
			);
			assert.equal(
				client.views.get(first.id)?.entries.filter((entry) => entry.kind === "pi.user").length,
				1,
				"restart did not resubmit input",
			);

			// Frontend changes must not interrupt the server or Durable workers.
			await appendFile(join(project, "src/web/style.css"), "\n/* HMR only */\n");
			await delay(900);
			assert.equal(urls().length, 2);

			// Shared and server sources also restart. Manual SIGUSR2 uses the same path.
			await appendFile(join(project, "src/shared/settings.ts"), "\n// shared restart\n");
			await until(() => urls().length === 3, 20_000);
			await appendFile(join(project, "src/server/http.ts"), "\n// server restart\n");
			await until(() => urls().length === 4, 20_000);
			child.kill("SIGUSR2");
			await until(() => urls().length === 5, 20_000);
			assert(log.includes("preserving 2 running workers"));
		} catch (error) {
			console.error(log);
			throw error;
		} finally {
			await client?.close();
			if (child.exitCode === null && child.signalCode === null) {
				const closed = once(child, "close");
				child.kill("SIGTERM");
				await closed;
			}
			await rm(directory, { recursive: true, force: true });
		}
	},
);
