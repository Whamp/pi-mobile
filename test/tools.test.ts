import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../src/server/app.ts";
import type { SessionSummary } from "../src/shared/protocol.ts";
import { Client, until } from "./client.ts";

test("coding tools use each worker's cwd; interrupted unsafe tools are not replayed", { timeout: 40_000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "mobile-tools-"));
	const app = await createApp({ directory, fake: true });
	let client: Client | undefined;
	try {
		await new Promise<void>((done) => app.http.listen(0, "127.0.0.1", done));
		const address = app.http.address();
		assert(address && typeof address !== "string");
		client = await Client.connect(`http://127.0.0.1:${address.port}`);
		const first = await client.request<SessionSummary>({
			type: "create",
			cwd: join(directory, "one", "..", "one"),
			createDirectory: true,
		});
		const second = await client.request<SessionSummary>({
			type: "create",
			cwd: join(directory, "two"),
			createDirectory: true,
		});
		assert.notEqual(first.worker.pid, second.worker.pid);
		assert.equal(first.cwd, join(directory, "one"));
		await Promise.all(
			[first, second].map((session) =>
				app.workers.command(session.id, { type: "prompt", content: "write", requestId: "write" }),
			),
		);
		await until(() =>
			[first, second].every((session) =>
				app.catalog.search("Echo").messages.some((message) => message.sessionId === session.id),
			),
		);
		assert.equal(await readFile(join(first.cwd, "created.txt"), "utf8"), "before\n");
		assert.equal(await readFile(join(second.cwd, "created.txt"), "utf8"), "before\n");
		await client.request({ type: "open", sessionId: first.id });
		await client.request({ type: "prompt", sessionId: first.id, content: "edit", requestId: "edit" });
		await until(() => app.catalog.search("Echo edit").messages.length === 1);
		assert.equal(await readFile(join(first.cwd, "created.txt"), "utf8"), "after\n");
		assert.equal(await readFile(join(second.cwd, "created.txt"), "utf8"), "before\n");
		await client.request({ type: "prompt", sessionId: first.id, content: "bash", requestId: "bash" });
		await until(() => app.catalog.search("Echo bash").messages.length === 1);
		const active = client;
		assert(
			active.views
				.get(first.id)
				?.entries.some((entry) =>
					entry.model?.some(
						(message) =>
							message.role === "toolResult" &&
							message.toolName === "bash" &&
							!message.isError &&
							message.content.some((part) => part.type === "text" && part.text.includes(first.cwd)),
					),
				),
		);
		await client.request({ type: "prompt", sessionId: first.id, content: "slow-tool", requestId: "slow-tool" });
		await until(() =>
			active.events.some((event) => event.type === "view" && JSON.stringify(event.ops).includes("tool-running")),
		);
		await client.request({ type: "stop", sessionId: first.id });
		await client.request({ type: "open", sessionId: first.id });
		await until(
			() =>
				active.views
					.get(first.id)
					?.entries.some(
						(entry) => entry.kind === "pi.tool-result" && JSON.stringify(entry.data).includes('"interrupted"'),
					) ?? false,
		);
		assert.equal(
			active.views
				.get(first.id)
				?.entries.filter(
					(entry) =>
						entry.kind === "pi.assistant" &&
						entry.model?.some(
							(message) =>
								message.role === "assistant" &&
								message.content.some(
									(part) =>
										part.type === "toolCall" && String(part.arguments.command).includes("tool-running"),
								),
						),
				).length,
			1,
		);
		assert.equal(app.catalog.search("tool-running").messages.length, 0);
	} finally {
		await client?.close();
		await app.close();
		await rm(directory, { recursive: true, force: true });
	}
});
