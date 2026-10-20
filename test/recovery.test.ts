import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../src/server/app.ts";
import { until } from "./client.ts";

test(
	"Android recovery resumes an unviewed worker after server and worker death without another input",
	{ timeout: 60_000 },
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "p2w-recovery-"));
		let app = await createApp({ directory, fake: true, recover: true });
		try {
			const session = app.catalog.create(directory, { provider: "faux", modelId: "faux-1" }, "off");
			await app.workers.open(session.id);
			const submitted = await app.workers.command(session.id, {
				type: "prompt",
				content: "slow recovered",
				requestId: "one-input",
			});
			await until(() => app.workers.status(session.id).tasks > 0);
			await app.close();
			app = await createApp({ directory, fake: true, recover: true });
			assert.deepEqual(app.catalog.resumable(), [session.id]);
			await app.workers.recover();
			await until(() => app.catalog.search("recovered").messages.some((message) => message.role === "assistant"));
			const oldPid = app.workers.status(session.id).pid;
			assert(oldPid);
			await app.workers.command(session.id, {
				type: "prompt",
				content: "slow workerresume",
				requestId: "two-input",
			});
			await until(() => app.workers.status(session.id).tasks > 0);
			process.kill(oldPid, "SIGKILL");
			await until(() => app.workers.status(session.id).pid !== oldPid && app.workers.status(session.id).running);
			await until(() => app.catalog.search("workerresume").messages.some((message) => message.role === "assistant"));
			const view = await app.workers.attach("proof", session.id, 1);
			assert.equal(view.entries.filter((entry) => entry.kind === "pi.user").length, 2);
			assert.equal(
				(
					await app.workers.command(session.id, {
						type: "prompt",
						content: "slow recovered",
						requestId: "one-input",
					})
				).submissionId,
				submitted.submissionId,
			);
			await app.workers.archive(session.id);
			assert.deepEqual(app.catalog.resumable(), []);
		} finally {
			await app.close();
			await rm(directory, { recursive: true, force: true });
		}
	},
);
