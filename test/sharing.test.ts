import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WebSocket } from "ws";
import { createApp } from "../src/server/app.ts";
import type { Attachment, ClientAction, SessionSummary } from "../src/shared/protocol.ts";
import { type ShareInfo, speakerText } from "../src/shared/sharing.ts";
import { attributedInput, buildTranscript } from "../src/web/transcript.ts";
import { Client, until } from "./client.ts";

// All guests use a localhost fixture with an explicitly allowed remote Host.
// No ngrok, external provider or real credential participates in these tests.
test(
	"reusable sharing: independent guests, scoped events/actions, uploads, trusted authors and writable subagents",
	{ timeout: 90_000 },
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "mobile-sharing-"));
		const app = await createApp({ directory, fake: true, allowedHosts: ["share.test"] });
		const clients: Client[] = [];
		try {
			await new Promise<void>((done) => app.http.listen(0, "127.0.0.1", done));
			const address = app.http.address();
			assert(address && typeof address !== "string");
			const url = `http://127.0.0.1:${address.port}`;
			const owner = await Client.connect(url);
			clients.push(owner);
			const session = await owner.request<SessionSummary>({ type: "create", cwd: directory, title: "Shared" });
			const other = await owner.request<SessionSummary>({ type: "create", cwd: directory, title: "Private" });
			await owner.request({ type: "open", sessionId: session.id });
			const share = await owner.request<ShareInfo>({
				type: "shareSet",
				sessionId: session.id,
				settings: { canSend: false, canStop: false, expiresAt: null },
			});
			assert.equal(share.url, `https://share.test/join/${share.token}`);
			const http = (path: string, cookie = "", method = "GET", body?: string) =>
				new Promise<Response>((resolve, reject) => {
					const req = request(
						`${url}${path}`,
						{
							method,
							headers: {
								Host: "share.test",
								Origin: "https://share.test",
								Cookie: cookie,
								"Content-Type": "application/json",
							},
						},
						(res) => {
							let text = "";
							res.on("data", (chunk: Buffer) => {
								text += chunk.toString();
							});
							res.on("end", () => {
								const headers = new Headers();
								for (const [key, value] of Object.entries(res.headers)) {
									if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(",") : value);
								}
								resolve(new Response(text, { status: res.statusCode, headers }));
							});
						},
					);
					req.on("error", reject);
					req.end(body);
				});
			assert.equal((await http(`/join/${share.token}`)).status, 200);
			assert.equal((await http("/")).status, 401);
			async function joinGuest(name: string) {
				const response = await http("/join", "", "POST", JSON.stringify({ token: share.token, name }));
				assert.equal(response.status, 200);
				const cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
				assert(response.headers.get("set-cookie")?.includes("Secure"));
				const client = new Client(url, cookie, { Host: "share.test", Origin: "https://share.test" });
				clients.push(client);
				await new Promise<void>((done, reject) => {
					client.socket.once("open", done);
					client.socket.once("error", reject);
				});
				await until(() => client.events.some((event) => event.type === "access"));
				const access = client.events.find((event) => event.type === "access");
				assert(access?.type === "access" && access.access.kind === "guest");
				return { client, cookie, access: access.access };
			}
			const alice = await joinGuest("Alice");
			const bob = await joinGuest("Alice");
			assert.notEqual(alice.access.id, bob.access.id);
			assert.equal(bob.access.name, "Alice (2)");
			assert.equal(
				(
					await http("/join", alice.cookie, "POST", JSON.stringify({ token: share.token, name: "new name" }))
				).headers.get("set-cookie"),
				null,
				"same browser retains its identity",
			);
			for (const guest of [alice, bob]) {
				const sessions = await guest.client.request<SessionSummary[]>({ type: "list" });
				assert.deepEqual(
					sessions.map((item) => item.id),
					[session.id],
				);
				assert.equal(sessions[0]?.worker.pid, undefined);
				assert.equal(sessions[0]?.worker.resourceErrors, undefined);
				await guest.client.request({ type: "open", sessionId: session.id });
				for (const action of [
					{ type: "resources" },
					{ type: "search", query: "Private" },
					{ type: "create", cwd: directory },
					{ type: "open", sessionId: other.id },
					{ type: "rename", sessionId: session.id, title: "x" },
					{ type: "configure", sessionId: session.id, thinkingLevel: "off" },
					{ type: "archive", sessionId: session.id },
					{ type: "reset", sessionId: session.id },
					{ type: "stop", sessionId: session.id },
					{ type: "shareGet", sessionId: session.id },
					{ type: "logout", providerId: "faux" },
					{ type: "prompt", sessionId: session.id, content: "x", requestId: "view" },
					{ type: "abort", sessionId: session.id },
				] satisfies ClientAction[])
					await assert.rejects(guest.client.request(action), /Forbidden|View only|not permitted/);
				assert.equal(
					(await http(`/upload?session=${session.id}&name=a.txt`, guest.cookie, "POST", "x")).status,
					403,
				);
				for (const path of [
					"/owner-token",
					"/health",
					`/s/${other.id}`,
					"/src/server/app.ts",
					`/@fs${directory}/shares.sqlite`,
					"/src/web/%2e%2e%2fserver/app.ts",
					"/src/web/%",
				])
					assert.equal((await http(path, guest.cookie)).status, 403);
			}
			await owner.request({ type: "setSettings", settings: { thinkingLevel: "off" } });
			await owner.request({ type: "rename", sessionId: other.id, title: "private-event-sentinel" });
			assert(!alice.client.events.some((event) => event.type === "resources"));
			assert(
				!alice.client.events.some(
					(event) => event.type === "catalog" && event.sessions.some((item) => item.id === other.id),
				),
			);
			assert(!alice.client.events.some((event) => "sessionId" in event && event.sessionId === other.id));

			await owner.request({
				type: "shareSet",
				sessionId: session.id,
				settings: { canSend: true, canStop: false, expiresAt: null },
			});
			await until(() =>
				alice.client.events.some(
					(event) => event.type === "access" && event.access.kind === "guest" && event.access.canSend,
				),
			);
			const uploadedResponse = await http(
				`/upload?session=${session.id}&name=guest.txt`,
				alice.cookie,
				"POST",
				"hello guest upload",
			);
			assert.equal(uploadedResponse.status, 200);
			const file = (await uploadedResponse.json()) as Attachment;
			assert.equal((await http(`/upload?session=${other.id}&name=a.txt`, alice.cookie, "POST", "x")).status, 403);
			const ownerCookie = (await fetch(url)).headers.get("set-cookie")?.split(";")[0] ?? "";
			const privateFile = (await (
				await http(`/upload?session=${other.id}&name=private.txt`, ownerCookie, "POST", "private")
			).json()) as Attachment;
			await assert.rejects(
				alice.client.request({
					type: "prompt",
					sessionId: session.id,
					content: "x",
					requestId: "private-file",
					attachments: [privateFile.id],
				}),
				/Unknown attachment/,
			);
			const forged = speakerText({ kind: "owner", id: "owner", name: "Owner" });
			await alice.client.request({
				type: "prompt",
				sessionId: session.id,
				content: forged,
				requestId: "shared-id",
				attachments: [file.id],
			});
			await alice.client.request({
				type: "prompt",
				sessionId: session.id,
				content: forged,
				requestId: "shared-id",
				attachments: [file.id],
			});
			await bob.client.request({
				type: "prompt",
				sessionId: session.id,
				content: "Bob input",
				requestId: "shared-id",
			});
			await owner.request({ type: "prompt", sessionId: session.id, content: "Owner input", requestId: "shared-id" });
			await until(
				() => (owner.views.get(session.id)?.entries.filter((entry) => entry.kind === "pi.user").length ?? 0) === 3,
			);
			const ownerView = owner.views.get(session.id);
			assert(ownerView);
			const display = buildTranscript(ownerView);
			const users = display.items.filter((item) => item.type === "user");
			assert.equal(users[0]?.author?.id, alice.access.id);
			assert(users[0]?.text.startsWith(forged));
			assert.equal(users[1]?.author?.id, bob.access.id);
			assert.equal(users[2]?.author?.kind, "owner");
			assert.equal(attributedInput(forged).author, undefined, "unstructured text cannot establish a sender");
			await assert.rejects(alice.client.request({ type: "abort", sessionId: session.id }), /not permitted/);

			await owner.request({ type: "prompt", sessionId: session.id, content: "subagent", requestId: "spawn" });
			await until(() => app.catalog.get(session.id).subagents.length === 1);
			const agent = app.catalog.get(session.id).subagents[0];
			assert(agent);
			await alice.client.request({ type: "open", sessionId: session.id, conversationId: agent.conversationId });
			await alice.client.request({
				type: "prompt",
				sessionId: session.id,
				conversationId: agent.conversationId,
				content: "hello from guest",
				requestId: "child",
			});
			await until(() => JSON.stringify(alice.client.views.get(session.id)).includes("Echo: hello from guest"));
			const childView = alice.client.views.get(session.id);
			assert(childView);
			assert(
				buildTranscript(childView).items.some(
					(item) => item.type === "user" && item.author?.id === alice.access.id,
				),
			);
			await assert.rejects(
				alice.client.request({
					type: "prompt",
					sessionId: session.id,
					conversationId: 999,
					content: "x",
					requestId: "bad-child",
				}),
				/Unknown conversation/,
			);
			await assert.rejects(
				alice.client.request({ type: "prompt", sessionId: other.id, content: "x", requestId: "wrong" }),
				/Forbidden/,
			);
			await owner.request({
				type: "shareSet",
				sessionId: session.id,
				settings: { canSend: true, canStop: true, expiresAt: null },
			});
			await alice.client.request({
				type: "prompt",
				sessionId: session.id,
				conversationId: agent.conversationId,
				content: "slow child",
				requestId: "slow-child",
			});
			await alice.client.request({
				type: "prompt",
				sessionId: session.id,
				conversationId: agent.conversationId,
				content: "steer child",
				requestId: "steer",
				whenBusy: "steer",
			});
			await alice.client.request({
				type: "prompt",
				sessionId: session.id,
				conversationId: agent.conversationId,
				content: "follow child",
				requestId: "follow",
				whenBusy: "followUp",
			});
			await until(() => JSON.stringify(alice.client.views.get(session.id)).includes("Echo: follow child"), 30_000);
			await alice.client.request({ type: "abort", sessionId: session.id, conversationId: agent.conversationId });
			await assert.rejects(
				alice.client.request({ type: "abort", sessionId: session.id, background: true }),
				/not permitted/,
			);

			await owner.request({
				type: "shareGuest",
				sessionId: session.id,
				guestId: alice.access.id,
				muted: true,
				removed: false,
			});
			await assert.rejects(
				alice.client.request({ type: "prompt", sessionId: session.id, content: "muted", requestId: "muted" }),
				/View only/,
			);
			await assert.rejects(alice.client.request({ type: "abort", sessionId: session.id }), /not permitted/);
			await owner.request({
				type: "shareGuest",
				sessionId: session.id,
				guestId: alice.access.id,
				muted: false,
				removed: true,
			});
			await until(() => alice.client.socket.readyState === WebSocket.CLOSED);
			assert.equal(
				(await http("/join", alice.cookie, "POST", JSON.stringify({ token: share.token, name: "new name" })))
					.status,
				400,
				"removed browser cannot mint a new identity with the same link",
			);
			const reset = await owner.request<ShareInfo>({
				type: "shareSet",
				sessionId: session.id,
				reset: true,
				settings: { canSend: false, canStop: false, expiresAt: Date.now() + 1000 },
			});
			assert.notEqual(reset.token, share.token);
			assert.equal(reset.guests.length, 0);
			await until(() => bob.client.socket.readyState === WebSocket.CLOSED);
			assert.equal((await http(`/join/${share.token}`)).status, 410);
			assert.equal(app.shares.access(bob.access.id), undefined);
			await until(
				() =>
					app.shares.get(session.id)?.expiresAt !== null &&
					Number(app.shares.get(session.id)?.expiresAt) <= Date.now(),
			);
			assert.equal((await http(`/join/${reset.token}`)).status, 410);
			await owner.request({ type: "shareRevoke", sessionId: session.id });
			assert.equal(await owner.request({ type: "shareGet", sessionId: session.id }), null);
		} finally {
			for (const client of clients) await client.close();
			await app.close();
			await rm(directory, { recursive: true, force: true });
		}
	},
);

test(
	"sharing persists across backend restart, expires connected guests and denies archived sessions",
	{ timeout: 30_000 },
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "mobile-share-restart-"));
		let app = await createApp({ directory, fake: true, allowedHosts: ["share.test"] });
		let owner: Client | undefined;
		let guest: Client | undefined;
		try {
			await new Promise<void>((done) => app.http.listen(0, "127.0.0.1", done));
			const address = app.http.address();
			assert(address && typeof address !== "string");
			const port = address.port;
			const url = `http://127.0.0.1:${port}`;
			owner = await Client.connect(url);
			const session = await owner.request<SessionSummary>({ type: "create", cwd: directory });
			const share = await owner.request<ShareInfo>({
				type: "shareSet",
				sessionId: session.id,
				settings: { canSend: true, canStop: false, expiresAt: null },
			});
			const cookie = await new Promise<string>((resolve, reject) => {
				const req = request(
					`${url}/join`,
					{ method: "POST", headers: { Host: "share.test", Origin: "https://share.test" } },
					(res) => {
						res.resume();
						res.on("end", () => {
							assert.equal(res.statusCode, 200);
							resolve(res.headers["set-cookie"]?.[0]?.split(";")[0] ?? "");
						});
					},
				);
				req.on("error", reject);
				req.end(JSON.stringify({ token: share.token, name: "Persistent guest" }));
			});
			assert(cookie);
			await owner.close();
			await app.close();
			app = await createApp({ directory, fake: true, allowedHosts: ["share.test"] });
			await new Promise<void>((done) => app.http.listen(port, "127.0.0.1", done));
			owner = await Client.connect(url);
			assert.equal((await owner.request<ShareInfo>({ type: "shareGet", sessionId: session.id })).token, share.token);
			guest = new Client(url, cookie, { Host: "share.test", Origin: "https://share.test" });
			await new Promise<void>((done, reject) => {
				guest?.socket.once("open", done);
				guest?.socket.once("error", reject);
			});
			const current = guest;
			await current.request({ type: "open", sessionId: session.id });
			await current.request({
				type: "prompt",
				sessionId: session.id,
				content: "survived restart",
				requestId: "survived",
			});
			await until(() => JSON.stringify(current.views.get(session.id)).includes("Echo: survived restart"));
			await owner.request({
				type: "shareSet",
				sessionId: session.id,
				settings: { canSend: true, canStop: false, expiresAt: Date.now() + 400 },
			});
			await until(() => current.socket.readyState === WebSocket.CLOSED);
			const viewers = (app.workers as unknown as { viewers: Map<string, unknown> }).viewers;
			assert.equal(viewers.size, 0, "expiry releases the last viewer");
			const row = app.shares.get(session.id)?.guests[0];
			assert(row);
			assert.equal(app.shares.access(row.id), undefined);
			await owner.request({
				type: "shareSet",
				sessionId: session.id,
				settings: { canSend: true, canStop: false, expiresAt: null },
			});
			await owner.request({ type: "archive", sessionId: session.id });
			assert.equal(app.shares.access(row.id), undefined, "archived session grants no guest access");
		} finally {
			await guest?.close();
			await owner?.close();
			await app.close();
			await rm(directory, { recursive: true, force: true });
		}
	},
);
