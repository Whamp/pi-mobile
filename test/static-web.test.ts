import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createWeb } from "../src/server/static-web.ts";

test("Android static hosting serves session routes and nonce assets without exposing app files", async () => {
	const directory = await mkdtemp(join(tmpdir(), "p2w-static-"));
	const previous = process.env.PI_MOBILE_WEB_DIR;
	process.env.PI_MOBILE_WEB_DIR = directory;
	await mkdir(join(directory, "assets"));
	await writeFile(
		join(directory, "index.html"),
		'<script nonce="__P2W_NONCE__" type="module" src="/assets/app-a1.js"></script>',
	);
	await writeFile(join(directory, "assets/app-a1.js"), 'document.title = "p2w";');
	await writeFile(join(directory, "auth.json"), "not-public");
	const http = createServer((request, response) => web.handle(request, response));
	const web = await createWeb(http, "test-nonce");
	try {
		await new Promise<void>((done) => http.listen(0, "127.0.0.1", done));
		const address = http.address();
		assert(address && typeof address !== "string");
		const origin = `http://127.0.0.1:${address.port}`;
		for (const route of [
			"/",
			"/s/12345678-1234-1234-1234-123456789abc",
			"/s/12345678-1234-1234-1234-123456789abc/a/2",
		]) {
			const response = await fetch(origin + route);
			assert.equal(response.status, 200);
			assert.equal(
				await response.text(),
				'<script nonce="test-nonce" type="module" src="/assets/app-a1.js"></script>',
			);
		}
		const script = await fetch(`${origin}/assets/app-a1.js`);
		assert.equal(script.headers.get("content-type"), "text/javascript; charset=utf-8");
		assert.equal(await script.text(), 'document.title = "p2w";');
		assert.equal(await (await fetch(origin, { method: "HEAD" })).text(), "");
		for (const path of [
			"/auth.json",
			"/assets/%2e%2e/auth.json",
			"/src/server/main.js",
			"/assets/missing.js",
			"/@fs/etc/passwd",
		])
			assert.equal((await fetch(origin + path)).status, 404);
	} finally {
		await new Promise<void>((done) => http.close(() => done()));
		await web.close();
		await rm(directory, { recursive: true, force: true });
		if (previous === undefined) delete process.env.PI_MOBILE_WEB_DIR;
		else process.env.PI_MOBILE_WEB_DIR = previous;
	}
});
