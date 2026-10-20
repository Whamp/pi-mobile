import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { applyImmutable } from "@earendil-works/chord/delta";
import type { ConversationView } from "@earendil-works/pi-durable";
import { WebSocket } from "ws";
import type { ClientAction, ServerEvent, WorkerStatus } from "../src/shared/protocol.ts";

export async function until(predicate: () => boolean, timeout = 15_000): Promise<void> {
	const deadline = Date.now() + timeout;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for state");
		await delay(20);
	}
}

export class Client {
	private readonly timeoutMs: number;
	readonly socket: WebSocket;
	readonly views = new Map<string, ConversationView>();
	readonly workers = new Map<string, WorkerStatus>();
	readonly events: ServerEvent[] = [];
	private readonly pending = new Map<
		string,
		{ resolve: (data: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
	>();

	constructor(url: string, cookie: string, headers: Record<string, string> = {}, timeoutMs = 30_000) {
		this.timeoutMs = timeoutMs;
		this.socket = new WebSocket(`${url.replace("http:", "ws:")}/ws`, {
			headers: { Cookie: cookie, Origin: url, ...headers },
		});
		this.socket.on("message", (data) => {
			const event = JSON.parse(data.toString()) as ServerEvent;
			this.events.push(event);
			switch (event.type) {
				case "result": {
					const pending = this.pending.get(event.id);
					this.pending.delete(event.id);
					clearTimeout(pending?.timer);
					if (event.error) pending?.reject(new Error(event.error));
					else pending?.resolve(event.data);
					break;
				}
				case "snapshot":
					this.views.set(event.sessionId, event.view);
					break;
				case "view": {
					const view = this.views.get(event.sessionId);
					assert(view, "deltas require a snapshot");
					this.views.set(event.sessionId, applyImmutable(view, event.ops));
					break;
				}
				case "worker":
					this.workers.set(event.sessionId, event.status);
					break;
			}
		});
		this.socket.on("close", () => {
			for (const pending of this.pending.values()) {
				clearTimeout(pending.timer);
				pending.reject(new Error("Disconnected"));
			}
			this.pending.clear();
		});
	}

	static async connect(url: string, timeoutMs = 30_000): Promise<Client> {
		const response = await fetch(url);
		const cookie = response.headers.get("set-cookie")?.split(";")[0];
		assert(cookie);
		const client = new Client(url, cookie, {}, timeoutMs);
		await new Promise<void>((done, reject) => {
			client.socket.once("open", done);
			client.socket.once("error", reject);
		});
		return client;
	}

	async request<T = unknown>(action: ClientAction): Promise<T> {
		const id = randomUUID();
		const result = new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Request timed out: ${action.type}`));
			}, this.timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
		});
		this.socket.send(JSON.stringify({ id, action }));
		return (await result) as T;
	}

	async close(): Promise<void> {
		if (this.socket.readyState === WebSocket.CLOSED) return;
		const closed = new Promise<void>((done) => this.socket.once("close", done));
		this.socket.close();
		await closed;
	}
}
