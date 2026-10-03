import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { UserMessage } from "@earendil-works/pi-ai";
import { createApp } from "../src/server/app.ts";
import type { Attachment, SessionSummary } from "../src/shared/protocol.ts";
import { Client, until } from "./client.ts";

const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
	"base64",
);

test(
	"uploads: cookie/origin protected, stored outside the project, attached to prompts",
	{ timeout: 60_000 },
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "mobile-uploads-"));
		const workspace = join(directory, "project");
		const app = await createApp({ directory, fake: true });
		let client: Client | undefined;
		try {
			await new Promise<void>((done) => app.http.listen(0, "127.0.0.1", done));
			const address = app.http.address();
			assert(address && typeof address !== "string");
			const url = `http://127.0.0.1:${address.port}`;
			const cookie = (await fetch(url)).headers.get("set-cookie")?.split(";")[0] ?? "";
			client = await Client.connect(url);
			const current = client;
			const session = await current.request<SessionSummary>({
				type: "create",
				cwd: workspace,
				createDirectory: true,
			});
			await current.request({ type: "open", sessionId: session.id });
			const post = (name: string, body: Buffer, headers: Record<string, string> = { Cookie: cookie, Origin: url }) =>
				fetch(`${url}/upload?${new URLSearchParams({ session: session.id, name })}`, {
					method: "POST",
					body: new Uint8Array(body),
					headers,
				});

			// Missing cookie, foreign origin or missing origin are rejected.
			assert.equal((await post("a.txt", Buffer.from("x"), { Origin: url })).status, 403);
			assert.equal(
				(await post("a.txt", Buffer.from("x"), { Cookie: cookie, Origin: "https://evil.test" })).status,
				403,
			);
			assert.equal((await post("a.txt", Buffer.from("x"), { Cookie: cookie })).status, 403);
			assert.equal(
				(
					await fetch(`${url}/upload?session=missing&name=a`, {
						method: "POST",
						body: "x",
						headers: { Cookie: cookie, Origin: url },
					})
				).status,
				400,
			);

			// Traversal-looking names are flattened; the file lands under the data directory.
			const response = await post("../../evil notes.txt", Buffer.from("uploaded-sentinel\n"));
			assert.equal(response.status, 200);
			const text = (await response.json()) as Attachment;
			assert.equal(text.name, "evil_notes.txt");
			assert.equal(text.path, join(directory, "uploads", session.id, `${text.id}-evil_notes.txt`));
			assert.equal((await stat(text.path)).mode & 0o777, 0o600);
			assert.deepEqual(await readdir(workspace), [], "nothing is written into the project");
			const image = (await (await post("dot.png", PNG)).json()) as Attachment;
			assert.equal(image.mimeType, "image/png");

			// Prompts carry IDs only; unknown IDs are rejected before reaching the worker.
			await assert.rejects(
				current.request({
					type: "prompt",
					sessionId: session.id,
					content: "x",
					requestId: "bad",
					attachments: ["../../etc/passwd"],
				}),
				/Unknown attachment/,
			);
			await current.request({
				type: "prompt",
				sessionId: session.id,
				content: "",
				requestId: "files",
				attachments: [text.id, image.id],
			});
			await until(() => Boolean(current.views.get(session.id)?.entries.some((entry) => entry.kind === "pi.user")));
			const user = current.views.get(session.id)?.entries.find((entry) => entry.kind === "pi.user")
				?.model?.[0] as UserMessage;
			assert(Array.isArray(user.content));
			const note = user.content[1];
			assert(note?.type === "text" && note.text.includes(text.path) && note.text.includes(image.path));
			// The fake model accepts images, so the PNG is also inlined.
			const inline = user.content[2];
			assert(inline?.type === "image" && inline.mimeType === "image/png" && inline.data === PNG.toString("base64"));
			assert.equal(await readFile(text.path, "utf8"), "uploaded-sentinel\n");
		} finally {
			await client?.close();
			await app.close();
			await rm(directory, { recursive: true, force: true });
		}
	},
);
