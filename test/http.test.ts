import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WebSocket } from "ws";
import { createApp } from "../src/server/app.ts";
import { createMobileServer } from "../src/server/http.ts";

test("local placeholder, health, methods and origin/host protection", async () => {
	const server = createMobileServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const address = server.address();
		assert(address && typeof address !== "string");
		const origin = `http://127.0.0.1:${address.port}`;
		assert.equal((await fetch(origin)).status, 200);
		assert.deepEqual(await (await fetch(`${origin}/health`)).json(), { ok: true, name: "pi-mobile" });
		assert.equal((await fetch(`${origin}/missing`)).status, 404);
		assert.equal((await fetch(origin, { method: "POST" })).status, 405);
		assert.equal((await fetch(origin, { headers: { Origin: "https://example.com" } })).status, 403);
		const status = await new Promise<number | undefined>((resolve, reject) => {
			const req = request(origin, { headers: { Host: "example.com" } }, (res) => {
				res.resume();
				resolve(res.statusCode);
			});
			req.on("error", reject);
			req.end();
		});
		assert.equal(status, 403);
	} finally {
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	}
});

function raw(url: string, headers: Record<string, string>) {
	return new Promise<{ status?: number; headers: Record<string, unknown> }>((resolve, reject) => {
		const req = request(url, { headers }, (res) => {
			res.resume();
			resolve({ status: res.statusCode, headers: res.headers });
		});
		req.on("error", reject);
		req.end();
	});
}

test("allowed tunnel hosts: https origin, Secure cookie, other hosts still rejected", async () => {
	const directory = await mkdtemp(join(tmpdir(), "mobile-tunnel-"));
	const app = await createApp({ directory, fake: true, allowedHosts: ["pim.example.test"] });
	try {
		await new Promise<void>((resolve) => app.http.listen(0, "127.0.0.1", resolve));
		const address = app.http.address();
		assert(address && typeof address !== "string");
		const url = `http://127.0.0.1:${address.port}`;
		const tunnel = await raw(url, { Host: "pim.example.test" });
		assert.equal(tunnel.status, 200);
		assert.match(String(tunnel.headers["set-cookie"]), /; Secure/);
		assert.match(String(tunnel.headers["content-security-policy"]), /connect-src 'self' wss:\/\/pim\.example\.test;/);
		assert.equal((await raw(url, { Host: "pim.example.test", Origin: "https://pim.example.test" })).status, 200);
		assert.equal(
			(await raw(url, { Host: "pim.example.test", Origin: `http://127.0.0.1:${address.port}` })).status,
			403,
		);
		assert.equal((await raw(url, { Host: "pim.example.test", Origin: "http://pim.example.test" })).status, 403);
		assert.equal((await raw(url, { Host: "other.example.test" })).status, 403);
		assert.doesNotMatch(String((await raw(url, {})).headers["set-cookie"]), /Secure/);

		// Tunnel WebSockets work, but provider login stays local-only.
		const cookie = String(tunnel.headers["set-cookie"]).split(";")[0] ?? "";
		const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`, {
			headers: { Host: "pim.example.test", Origin: "https://pim.example.test", Cookie: cookie },
		});
		await new Promise((resolve, reject) => {
			socket.once("open", resolve);
			socket.once("error", reject);
		});
		const reply = new Promise<{ error?: string }>((resolve) =>
			socket.on("message", (data) => {
				const message = JSON.parse(String(data)) as { type: string; error?: string };
				if (message.type === "result") resolve(message);
			}),
		);
		socket.send(JSON.stringify({ id: "1", action: { type: "login", providerId: "faux", authType: "api_key" } }));
		assert.match((await reply).error ?? "", /only available on the device/);
		socket.close();
	} finally {
		await app.close();
		await rm(directory, { recursive: true, force: true });
	}
});
