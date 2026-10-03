import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ConversationView, EntryId } from "@earendil-works/pi-durable";
import { type ComponentType, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createApp } from "../src/server/app.ts";
import type { buildTranscript, Transcript } from "../src/web/transcript.ts";
import { Client } from "./client.ts";

// Transform/SSR tests exercise the actual Vite pipeline without a paid provider
// or a production build. A real mobile browser remains the layout smoke check.
test(
	"localhost React/Vite UI serves HMR-capable modules and denies credential/data files",
	{ timeout: 30_000 },
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "mobile-web-"));
		const app = await createApp({ directory, fake: true, web: true });
		let client: Client | undefined;
		try {
			await new Promise<void>((done) => app.http.listen(0, "127.0.0.1", done));
			const address = app.http.address();
			assert(address && typeof address !== "string");
			const url = `http://127.0.0.1:${address.port}`;
			const response = await fetch(url);
			const html = await response.text();
			assert.equal(response.status, 200);
			assert(html.includes("/src/web/main.tsx"));
			assert(html.includes("/@vite/client"));
			assert.match(response.headers.get("content-security-policy") ?? "", /script-src 'self' 'nonce-/);
			assert.match(html, /nonce="[a-f0-9]+"/);
			const main = await fetch(`${url}/src/web/main.tsx`);
			assert.equal(main.status, 200);
			assert((await main.text()).includes("createRoot"));
			const appModule = await app.web?.vite.transformRequest("/src/web/App.tsx");
			assert(appModule?.code.includes("Message Pi"));
			const css = await fetch(`${url}/src/web/style.css`);
			assert.equal(css.status, 200);
			for (const path of [
				"/auth.json",
				"/models.json",
				`/@fs${join(directory, "auth.json")}`,
				`/@fs${join(directory, "catalog.sqlite")}`,
			]) {
				assert.notEqual((await fetch(`${url}${path}`)).status, 200);
			}
			assert.equal(
				(await fetch(`${url}/src/web/main.tsx`, { headers: { Origin: "https://example.com" } })).status,
				403,
			);
			client = await Client.connect(url);
			await client.request({ type: "resources" });
			const chat = (await app.web?.vite.ssrLoadModule("/src/web/Chat.tsx")) as unknown as {
				Messages: ComponentType<{ transcript: Transcript }>;
			};
			const model = (await app.web?.vite.ssrLoadModule("/src/web/transcript.ts")) as unknown as {
				buildTranscript: typeof buildTranscript;
			};
			const conversationId = 1 as ConversationView["conversation"]["id"];
			const assistant = {
				role: "assistant" as const,
				content: [
					{ type: "text" as const, text: "Running **bash**." },
					{ type: "toolCall" as const, id: "call-1", name: "bash", arguments: { command: "ls -la" } },
				],
				api: "faux",
				provider: "faux",
				model: "faux-1",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse" as const,
				timestamp: 2,
			};
			const view: ConversationView = {
				conversation: { id: conversationId } as ConversationView["conversation"],
				docs: {
					"pi.live": {
						run: { taskId: 1, inputs: [1] },
						tools: [
							{ callId: "call-1", name: "bash", taskId: 2, status: "running", output: "line-one\nline-two" },
						],
					},
				},
				entries: [
					{
						id: 1 as EntryId,
						conversationId,
						kind: "pi.user",
						model: [{ role: "user", content: "<script>not executable</script>", timestamp: 1 }],
					},
					{ id: 2 as EntryId, conversationId, kind: "pi.assistant", model: [assistant] },
				],
			};
			// One tool card follows the call through its live slot; no separate result block.
			const running = model.buildTranscript(view);
			assert.equal(running.items.length, 2);
			const item = running.items[1];
			assert(item?.type === "assistant");
			assert.equal(item.tools[0]?.status, "running");
			assert.equal(item.tools[0]?.output, "line-one\nline-two");
			const rendered = renderToStaticMarkup(createElement(chat.Messages, { transcript: running }));
			assert(rendered.includes("&lt;script&gt;not executable&lt;/script&gt;"));
			assert(!rendered.includes("<script>"));
			assert(rendered.includes("<strong>bash</strong>"));
			assert(rendered.includes("ls -la"));
			assert(rendered.includes("line-two"), "running tool output is previewed while collapsed");
			const done = model.buildTranscript({
				...view,
				docs: {
					"pi.live": {
						run: { taskId: 1, inputs: [1] },
						generation: {
							attempt: 1,
							message: {
								...assistant,
								content: [{ type: "text", text: "Streaming partial" }],
								stopReason: "stop",
							},
						},
					},
				},
				entries: [
					...view.entries,
					{
						id: 3 as EntryId,
						conversationId,
						kind: "pi.tool-result",
						model: [
							{
								role: "toolResult",
								toolCallId: "call-1",
								toolName: "bash",
								content: [{ type: "text", text: "total 0" }],
								isError: false,
								timestamp: 3,
							},
						],
					},
				],
			});
			assert.equal(done.items.length, 3, "tool result is merged into the call; the live partial is appended");
			const merged = done.items[1];
			assert(
				merged?.type === "assistant" && merged.tools[0]?.status === "done" && merged.tools[0].output === "total 0",
			);
			const live = done.items[2];
			assert(live?.type === "assistant" && live.streaming);
			assert(renderToStaticMarkup(createElement(chat.Messages, { transcript: done })).includes("Streaming partial"));
			// Fenced code is highlighted as React elements, with copy buttons on code and answers.
			const markdown = (await app.web?.vite.ssrLoadModule("/src/web/Markdown.tsx")) as unknown as {
				Markdown: ComponentType<{ text: string }>;
			};
			const code = renderToStaticMarkup(createElement(markdown.Markdown, { text: '```ts\nconst x = "<b>";\n```' }));
			assert(code.includes('<span class="hljs-keyword">const</span>'));
			assert(code.includes("&lt;b&gt;") && !code.includes("<b>"), "highlighted code is escaped");
			assert(code.includes('aria-label="Copy"'));
			const answered = renderToStaticMarkup(
				createElement(chat.Messages, {
					transcript: model.buildTranscript({
						...view,
						docs: {},
						entries: [
							{
								id: 1 as EntryId,
								conversationId,
								kind: "pi.user",
								model: [
									{
										role: "user",
										content:
											"look\n\n<attachments>\nThe user attached these files:\n- /x/uploads/s/id-notes.txt (notes.txt, 4 bytes)\n</attachments>",
										timestamp: 1,
									},
								],
							},
							{
								id: 2 as EntryId,
								conversationId,
								kind: "pi.assistant",
								model: [{ ...assistant, content: [{ type: "text", text: "Done." }], stopReason: "stop" }],
							},
						],
					}),
				}),
			);
			assert(answered.includes('class="message-actions"'));
			assert(answered.includes("<span>notes.txt</span>") && !answered.includes("&lt;attachments&gt;"));
		} finally {
			await client?.close();
			await app.close();
			await rm(directory, { recursive: true, force: true });
		}
	},
);
