import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { createApp } from "../src/server/app.ts";
import type { SessionSummary } from "../src/shared/protocol.ts";
import { Client, until } from "./client.ts";

function texts(client: Client, sessionId: string): string[] {
	return (client.views.get(sessionId)?.entries ?? []).flatMap((entry) =>
		(entry.model ?? []).flatMap((message) =>
			typeof message.content === "string"
				? [message.content]
				: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
		),
	);
}

test(
	"background subagents: configured spawn, report, sidebar listing, on-demand watches",
	{ timeout: 60_000 },
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "mobile-subagents-"));
		const app = await createApp({ directory, fake: true });
		let client: Client | undefined;
		try {
			await new Promise<void>((done) => app.http.listen(0, "127.0.0.1", done));
			const address = app.http.address();
			assert(address && typeof address !== "string");
			client = await Client.connect(`http://127.0.0.1:${address.port}`);
			const current = client;
			const session = await current.request<SessionSummary>({ type: "create", cwd: directory });
			await current.request({ type: "open", sessionId: session.id });

			// An invalid model fails the tool call itself and creates nothing.
			await current.request({ type: "prompt", sessionId: session.id, content: "subagent-bad", requestId: "bad" });
			await until(() => texts(current, session.id).some((text) => text.includes("Unknown model nope/missing")));
			assert.equal(app.catalog.get(session.id).subagents.length, 0);

			await current.request({ type: "prompt", sessionId: session.id, content: "subagent", requestId: "spawn" });
			// The answer is reported back to the main conversation as a follow-up input.
			await until(
				() =>
					texts(current, session.id).some(
						(text) => text.startsWith("[subagent helper answered") && text.includes("Echo: hello helper"),
					),
				20_000,
			);
			const result = current.views
				.get(session.id)
				?.entries.flatMap((entry) => entry.model ?? [])
				.find(
					(message): message is ToolResultMessage =>
						message.role === "toolResult" && message.toolName === "subagent" && !message.isError,
				);
			assert.deepEqual(
				{ ...(result?.details as object), conversationId: undefined },
				{
					action: "spawn",
					name: "helper",
					conversationId: undefined,
					model: "faux/faux-1",
					thinkingLevel: "off",
					tools: ["read"],
				},
				"thinking is clamped to the model; tools are restricted",
			);

			// The catalog lists the subagent for the sidebar.
			await until(() => app.catalog.get(session.id).subagents.length === 1);
			const [agent] = app.catalog.get(session.id).subagents;
			assert(agent && agent.name === "helper" && agent.conversationId > 1);

			// Opening the subagent swaps this client's single watch.
			await current.request({ type: "open", sessionId: session.id, conversationId: agent.conversationId });
			const snapshot = current.events.findLast((event) => event.type === "snapshot");
			assert(snapshot?.type === "snapshot" && snapshot.conversationId === agent.conversationId);
			const sub = snapshot.view;
			assert(
				sub.entries.some(
					(entry) => entry.kind === "pi.user" && JSON.stringify(entry.model).includes("hello helper"),
				),
			);
			assert.equal((sub.docs["pi.agent"] as { tools?: string[] }).tools?.join(), "read");
			const worker = app.workers as unknown as { running: Map<string, { views: Map<number, unknown> }> };
			assert.deepEqual(
				[...(worker.running.get(session.id)?.views.keys() ?? [])],
				[agent.conversationId],
				"the main watch was released",
			);
			await assert.rejects(
				current.request({ type: "open", sessionId: session.id, conversationId: 999 }),
				/Unknown conversation/,
			);

			// Frames of the main conversation no longer reach this client.
			const before = current.events.length;
			await app.workers.command(session.id, { type: "prompt", content: "hello main", requestId: "main" });
			await until(() => app.catalog.search("hello main").messages.length > 0);
			assert(!current.events.slice(before).some((event) => event.type === "view" && event.conversationId === 1));

			// Leaving releases every watch, but the worker's state and the sidebar stay.
			await current.request({ type: "heartbeat", sessionId: null });
			await until(() => worker.running.get(session.id)?.views.size === 0);
			await current.request({ type: "stop", sessionId: session.id });
			assert.equal(app.catalog.get(session.id).subagents[0]?.name, "helper");
		} finally {
			await client?.close();
			await app.close();
			await rm(directory, { recursive: true, force: true });
		}
	},
);
