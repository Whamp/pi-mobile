import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { codemodeResult } from "../scripts/torture.ts";
import { createApp } from "../src/server/app.ts";
import { Client, until } from "./client.ts";

test(
	"a watch opened during rapid codemode commits keeps its snapshot and every following delta",
	{ timeout: 90_000 },
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "p2w-watch-"));
		const previous = process.env.PI_MOBILE_TORTURE_SLEEP;
		process.env.PI_MOBILE_TORTURE_SLEEP = "0.01";
		const app = await createApp({ directory, fake: true });
		await new Promise<void>((done) => app.http.listen(0, "127.0.0.1", done));
		const address = app.http.address();
		assert(address && typeof address !== "string");
		const client = await Client.connect(`http://127.0.0.1:${address.port}`);
		try {
			for (let iteration = 0; iteration < 12; iteration++) {
				const session = app.catalog.create(directory, { provider: "faux", modelId: "faux-1" }, "off");
				await app.workers.command(session.id, {
					type: "prompt",
					content: `torture watch-${iteration}`,
					requestId: `watch-${iteration}`,
				});
				await client.request({ type: "open", sessionId: session.id });
				await until(() => codemodeResult(client.views.get(session.id)) !== undefined);
				const result = codemodeResult(client.views.get(session.id));
				assert.deepEqual(
					result?.value.results,
					Array.from({ length: 12 }, (_, index) => `${index + 1}: ok`),
				);
				assert.equal(result?.calls.length, 14);
				assert.equal(app.workers.status(session.id).error, undefined);
				await app.workers.stop(session.id);
			}
		} finally {
			await client.close();
			await app.close();
			if (previous === undefined) delete process.env.PI_MOBILE_TORTURE_SLEEP;
			else process.env.PI_MOBILE_TORTURE_SLEEP = previous;
			await rm(directory, { recursive: true, force: true });
		}
	},
);
