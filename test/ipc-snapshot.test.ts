import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyImmutable } from "@earendil-works/chord/delta";
import type { ConversationView } from "@earendil-works/pi-durable";
import { WebSocket } from "ws";
import { createApp } from "../src/server/app.ts";
import type { ServerEvent, WorkerEvent } from "../src/shared/protocol.ts";
import { until } from "./client.ts";

test("coalesced real worker IPC sends its snapshot before any delta to the browser", { timeout: 45_000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "p2w-ipc-order-"));
	const app = await createApp({ directory, fake: true });
	let socket: WebSocket | undefined;
	let restore: (() => void) | undefined;
	try {
		await new Promise<void>((done) => app.http.listen(0, "127.0.0.1", done));
		const address = app.http.address();
		assert(address && typeof address !== "string");
		const url = `http://127.0.0.1:${address.port}`;
		const session = app.catalog.create(directory, { provider: "faux", modelId: "faux-1" }, "off");
		await app.workers.open(session.id);
		const { child } =
			(app.workers as unknown as { running: Map<string, { child: ChildProcess }> }).running.get(session.id) ?? {};
		assert(child);
		const listeners = child.listeners("message");
		assert.equal(listeners.length, 1);
		const receive = listeners[0] as (event: WorkerEvent) => void;
		const buffered: WorkerEvent[] = [];
		let batching = false;
		let coalesced = false;
		const relay = (event: WorkerEvent) => {
			if (!batching && event.type === "result" && event.view) batching = true;
			if (!batching) return receive(event);
			buffered.push(event);
			if (event.type !== "view") return;
			child.removeListener("message", relay);
			child.on("message", receive);
			coalesced = true;
			// Node drains coalesced IPC nextTicks before Promise continuations.
			for (const message of buffered) receive(message);
		};
		child.removeListener("message", receive);
		child.on("message", relay);
		restore = () => {
			child.removeListener("message", relay);
			if (!child.listeners("message").includes(receive)) child.on("message", receive);
		};
		await app.workers.command(session.id, { type: "prompt", content: "slow batched-watch", requestId: "once" });
		const response = await fetch(url);
		const cookie = response.headers.get("set-cookie")?.split(";")[0];
		assert(cookie);
		socket = new WebSocket(`${url.replace("http:", "ws:")}/ws`, { headers: { Cookie: cookie, Origin: url } });
		const events: ServerEvent[] = [];
		socket.on("message", (data) => events.push(JSON.parse(data.toString()) as ServerEvent));
		await new Promise<void>((done, reject) => {
			socket?.once("open", done);
			socket?.once("error", reject);
		});
		socket.send(JSON.stringify({ id: "open", action: { type: "open", sessionId: session.id } }));
		await until(() => events.some((event) => event.type === "result" && event.id === "open"));
		assert(coalesced, "the real snapshot and delta were delivered in one synchronous IPC batch");
		const frames = events.filter((event) => event.type === "snapshot" || event.type === "view");
		assert.equal(frames[0]?.type, "snapshot", "a browser must receive its base before a delta");
		let cursor = 0;
		let view: ConversationView | undefined;
		await until(() => {
			for (const event of events.slice(cursor)) {
				if (event.type === "snapshot") view = event.view;
				else if (event.type === "view") {
					assert(view);
					view = applyImmutable(view, event.ops);
				}
			}
			cursor = events.length;
			return view?.entries.some((entry) => entry.kind === "pi.assistant") ?? false;
		});
		const text = view?.entries
			.flatMap((entry) => entry.model ?? [])
			.flatMap((message) =>
				message.role === "assistant"
					? message.content.filter((part) => part.type === "text").map((part) => part.text)
					: [],
			)
			.join("");
		assert.equal(text, `Echo: slow batched-watch ${"streaming ".repeat(300)}`);
		assert.equal(app.workers.status(session.id).error, undefined);
	} finally {
		restore?.();
		if (socket && socket.readyState !== WebSocket.CLOSED) {
			const closed = new Promise<void>((done) => socket?.once("close", done));
			socket.close();
			await closed;
		}
		await app.close();
		await rm(directory, { recursive: true, force: true });
	}
});
