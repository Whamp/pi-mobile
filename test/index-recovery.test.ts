import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, Harness, UserEntry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Catalog } from "../src/server/catalog.ts";
import { Workers } from "../src/server/workers.ts";
import { createMobileModels } from "../src/shared/models.ts";
import type { WorkerCommand, WorkerEvent } from "../src/shared/protocol.ts";

test(
	"interrupted multi-page indexing retries committed batches without duplicates or a cursor gap",
	{ timeout: 20_000 },
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "mobile-index-recovery-"));
		const catalog = new Catalog(directory);
		const workers = new Workers(catalog, { fake: true });
		const session = catalog.create(directory, { provider: "faux", modelId: "faux-1" }, "off");
		const harness = await Harness.open(
			await openNodeSqliteStorage(catalog.storagePath(session.id)),
			{
				models: createMobileModels(true),
				registry: createRegistry(),
			},
			BACKGROUND_CONTEXT,
		);
		const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: session.model, cwd: directory } });
		await root.commit(async (tx) => {
			for (let i = 0; i < 225; i++)
				await tx.appendEntry(UserEntry, root.id, {
					model: [{ role: "user", content: `indexfixture${i}`, timestamp: Date.now() }],
				});
		}, BACKGROUND_CONTEXT);
		await harness.close(BACKGROUND_CONTEXT);
		const child = fork(new URL("../src/worker/main.ts", import.meta.url), [], {
			execArgv: [],
			stdio: ["ignore", "ignore", "ignore", "ipc"],
		});
		const exited = new Promise<void>((done) => child.once("close", () => done()));
		try {
			const firstBatch = new Promise<Extract<WorkerEvent, { type: "index" }>>((done, reject) => {
				child.once("error", reject);
				child.on("message", (event: WorkerEvent) => {
					if (event.type === "fatal") reject(new Error(event.error));
					if (event.type === "index") done(event);
				});
			});
			const init: WorkerCommand = {
				type: "init",
				session,
				storagePath: catalog.storagePath(session.id),
				fake: true,
				resume: false,
			};
			child.send(init);
			const batch = await firstBatch;
			assert.equal(batch.through, 0, "cursor must not advance until the oldest page has committed");
			catalog.index(session.id, batch.messages, batch.through);
			child.kill("SIGKILL"); // Simulate a crash after commit, before acknowledgement.
			await exited;
			assert.equal(catalog.get(session.id).indexedThrough, 0);
			await workers.open(session.id);
			assert.equal(catalog.search("indexfixture0").messages.length, 1);
			assert.equal(catalog.search("indexfixture224").messages.length, 1);
			const db = new DatabaseSync(join(directory, "catalog.sqlite"), { readOnly: true });
			try {
				assert.equal(db.prepare("SELECT count(*) AS count FROM messages").get()?.count, 225);
			} finally {
				db.close();
			}
			assert.equal(catalog.get(session.id).title, "indexfixture0");
		} finally {
			child.kill("SIGKILL");
			await exited;
			await workers.close();
			catalog.close();
			await rm(directory, { recursive: true, force: true });
		}
	},
);
