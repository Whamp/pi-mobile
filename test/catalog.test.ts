import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Catalog } from "../src/server/catalog.ts";
import type { IndexedMessage } from "../src/shared/protocol.ts";

const model = { provider: "faux", modelId: "faux-1" };

test("catalog persists metadata and idempotent FTS indexing, with atomic cursor updates", async () => {
	const directory = await mkdtemp(join(tmpdir(), "mobile-catalog-"));
	let catalog = new Catalog(directory);
	try {
		const session = catalog.create("/project", model, "off");
		const messages: IndexedMessage[] = [
			{ conversationId: 1, entryId: 20, role: "assistant", timestamp: Date.now(), text: "Answer uniqueanswer" },
			{ conversationId: 1, entryId: 10, role: "user", timestamp: Date.now(), text: "First\nquestion" },
		];
		catalog.index(session.id, messages, 25);
		catalog.index(session.id, messages, 25);
		assert.equal(catalog.search("uniqueanswer").messages.length, 1);
		assert.equal(catalog.get(session.id).title, "First question");
		catalog.index(session.id, [{ ...messages[1], entryId: 5, text: "Earlier input" }], 30);
		assert.equal(catalog.get(session.id).title, "Earlier input");
		catalog.rename(session.id, "Manual title");
		catalog.index(session.id, messages, 10);
		assert.equal(catalog.get(session.id).title, "Manual title");
		assert.equal(catalog.get(session.id).indexedThrough, 30);
		assert.equal(catalog.search("Manual").sessions.length, 1);
		assert.equal(catalog.search("/project").sessions.length, 1);
		assert.doesNotThrow(() => catalog.search('" OR (bad):*'));
		assert.throws(() =>
			catalog.index(
				session.id,
				[
					{ ...messages[0], entryId: 40, text: "rollback" },
					{ ...messages[1], entryId: 41, timestamp: Number.NaN },
				],
				50,
			),
		);
		assert.equal(catalog.search("rollback").messages.length, 0);
		assert.equal(catalog.get(session.id).indexedThrough, 30);
		catalog.pin(session.id, true);
		catalog.archive(session.id, true);
		assert.equal(catalog.list(false).length, 0);
		assert.equal(catalog.search("uniqueanswer", true).messages.length, 1);
		catalog.close();
		catalog = new Catalog(directory);
		assert.equal(catalog.get(session.id).pinned, true);
		assert.equal(catalog.search("uniqueanswer", true).messages.length, 1);
		catalog.archive(session.id, false);
		catalog.resetIndex(session.id);
		assert.equal(catalog.get(session.id).indexedThrough, 0);
		assert.equal(catalog.search("uniqueanswer").messages.length, 0);
		catalog.index(session.id, messages, 25);
		assert.equal(catalog.search("uniqueanswer").messages.length, 1);
		assert.equal(catalog.get(session.id).title, "Manual title");
	} finally {
		catalog.close();
		await rm(directory, { recursive: true, force: true });
	}
});
