import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WebSocket } from "ws";
import { createApp } from "../src/server/app.ts";
import { MobileClient } from "../src/web/client.ts";
import { until } from "./client.ts";

test(
	"returning from the system browser reacquires an expired view without submitting input",
	{ timeout: 30_000 },
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "p2w-client-recovery-"));
		const app = await createApp({ directory, fake: true, heartbeatMs: 200 });
		const originalFetch = globalThis.fetch;
		const keys = ["window", "document", "location", "history", "localStorage", "WebSocket", "fetch"];
		const saved = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
		let client: MobileClient | undefined;
		try {
			await new Promise<void>((done) => app.http.listen(0, "127.0.0.1", done));
			const address = app.http.address();
			assert(address && typeof address !== "string");
			const origin = `http://127.0.0.1:${address.port}`;
			let cookie = "";
			class BrowserSocket extends WebSocket {
				constructor(url: string) {
					super(url, { headers: { Cookie: cookie, Origin: origin } });
				}
			}
			const document = Object.assign(new EventTarget(), { visibilityState: "visible" });
			const storage = new Map<string, string>();
			const values: Record<string, unknown> = {
				window: new EventTarget(),
				document,
				location: new URL(origin),
				history: { pushState() {} },
				localStorage: {
					getItem: (key: string) => storage.get(key) ?? null,
					setItem: (key: string, value: string) => storage.set(key, value),
					removeItem: (key: string) => storage.delete(key),
				},
				WebSocket: BrowserSocket,
				fetch: async (input: string, init?: RequestInit) => {
					const response = await originalFetch(new URL(input, origin), init);
					cookie = response.headers.get("set-cookie")?.split(";")[0] ?? cookie;
					return response;
				},
			};
			for (const [key, value] of Object.entries(values))
				Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
			const browser = new MobileClient();
			client = browser;
			browser.start();
			await until(() => browser.snapshot().resources !== undefined);
			const session = app.catalog.create(directory, { provider: "faux", modelId: "faux-1" }, "off");
			await browser.open(session.id, 1, false);
			const workers = app.workers as unknown as { running: Map<string, { views: Map<number, unknown> }> };
			await until(() => workers.running.get(session.id)?.views.size === 0);
			await app.workers.command(session.id, {
				type: "prompt",
				content: "while browser was away",
				requestId: "only-input",
			});
			await until(() => app.catalog.search("away").messages.some((message) => message.role === "assistant"));
			assert.equal(browser.snapshot().view?.entries.filter((entry) => entry.kind === "pi.user").length, 0);
			document.dispatchEvent(new Event("visibilitychange"));
			await until(() => browser.snapshot().view?.entries.some((entry) => entry.kind === "pi.assistant") === true);
			assert.equal(browser.snapshot().view?.entries.filter((entry) => entry.kind === "pi.user").length, 1);
			assert.equal(browser.snapshot().conversationId, 1);
		} finally {
			client?.stop();
			await app.close();
			for (const key of keys) {
				const descriptor = saved.get(key);
				if (descriptor) Object.defineProperty(globalThis, key, descriptor);
				else Reflect.deleteProperty(globalThis, key);
			}
			await rm(directory, { recursive: true, force: true });
		}
	},
);
