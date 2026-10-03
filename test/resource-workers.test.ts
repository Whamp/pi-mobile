import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createApp } from "../src/server/app.ts";
import type { SessionSummary } from "../src/shared/protocol.ts";
import type { ResourceSnapshot } from "../src/shared/resources.ts";
import { Client, until } from "./client.ts";

function sections(client: Client, sessionId: string) {
	return client.views
		.get(sessionId)
		?.entries.flatMap((entry) => entry.model ?? [])
		.filter((message) => message.role === "system")
		.at(-1)?.sections;
}

const skill = (description: string) => `---\nname: fixture\ndescription: ${description}\n---\nRead the fixture.\n`;

test(
	"server settings API and independent worker settings/models/AGENTS/skill observation",
	{ timeout: 35_000 },
	async () => {
		const directory = await mkdtemp(join(tmpdir(), "mobile-resource-workers-"));
		const cwd = join(directory, "project");
		const skillPath = join(cwd, ".pi", "skills", "fixture", "SKILL.md");
		await mkdir(join(cwd, ".pi", "skills", "fixture"), { recursive: true });
		await writeFile(join(cwd, "AGENTS.md"), "old-agent-instructions");
		await writeFile(skillPath, skill("old-skill-description"));
		const app = await createApp({ directory, fake: true });
		let client: Client | undefined;
		try {
			await new Promise<void>((done) => app.http.listen(0, "127.0.0.1", done));
			const address = app.http.address();
			assert(address && typeof address !== "string");
			client = await Client.connect(`http://127.0.0.1:${address.port}`);
			const settings = {
				defaultModel: { provider: "faux", modelId: "faux-1" },
				thinkingLevel: "high" as const,
				compaction: { enabled: false },
				stream: { timeoutMs: 15000 },
				retry: { enabled: false, maxRetries: 0 },
			};
			await client.request({ type: "setSettings", settings });
			const state = await client.request<ResourceSnapshot>({ type: "resources" });
			assert.equal(state.settings.thinkingLevel, "high");
			const session = await client.request<SessionSummary>({ type: "create", cwd });
			assert.equal(session.thinkingLevel, "high");
			await client.request({ type: "open", sessionId: session.id });
			await client.request({ type: "prompt", sessionId: session.id, content: "before", requestId: "before" });
			const active = client;
			await until(() => app.catalog.search("Echo before").messages.length === 1);
			assert(String(sections(active, session.id)?.["agents-md"]).includes("old-agent-instructions"));
			assert(String(sections(active, session.id)?.skills).includes("old-skill-description"));
			// Deliberately stop ONLY the server's observer. Workers must still reload;
			// no server->worker resource notifications can explain the behavior below.
			await app.resources.close();
			await client.request({
				type: "prompt",
				sessionId: session.id,
				content: "slow boundary",
				requestId: "boundary",
			});
			await until(() =>
				active.events.some((event) => event.type === "view" && JSON.stringify(event.ops).includes("streaming")),
			);
			await writeFile(join(cwd, "replacement"), "new-agent-instructions");
			await rename(join(cwd, "replacement"), join(cwd, "AGENTS.md"));
			await writeFile(skillPath, skill("new-skill-description"));
			await writeFile(join(directory, "models.json"), "{model-secret-invalid-json");
			await writeFile(
				join(directory, "settings.json"),
				JSON.stringify({ ...settings, thinkingLevel: "low", stream: { timeoutMs: 12000 } }),
			);
			await until(
				() => app.workers.status(session.id).resourceErrors?.some((error) => error.resource === "models") ?? false,
			);
			assert.equal(app.resources.resourceErrors.length, 0, "server observer remains stopped and unchanged");
			await until(() =>
				app.catalog
					.search("boundary")
					.messages.some((message) => message.role === "assistant" && message.text.length > 2000),
			);
			assert(
				String(sections(active, session.id)?.["agents-md"]).includes("old-agent-instructions"),
				"resource changes do not rewrite an in-flight prompt",
			);
			await client.request({ type: "prompt", sessionId: session.id, content: "after", requestId: "after" });
			await until(() => app.catalog.search("Echo after").messages.length === 1);
			assert(String(sections(active, session.id)?.["agents-md"]).includes("new-agent-instructions"));
			assert(String(sections(active, session.id)?.skills).includes("new-skill-description"));
			assert(!JSON.stringify(active.events).includes("model-secret-invalid-json"));
			await rm(join(directory, "models.json"));
			await rm(join(cwd, "AGENTS.md"));
			await rm(join(cwd, ".pi", "skills"), { recursive: true });
			await until(() => app.workers.status(session.id).resourceErrors?.length === 0);
			await delay(1100);
			await client.request({ type: "prompt", sessionId: session.id, content: "removed", requestId: "removed" });
			await until(() => app.catalog.search("Echo removed").messages.length === 1);
			assert.equal(sections(active, session.id)?.["agents-md"], null);
			assert.equal(sections(active, session.id)?.skills, null);
			await client.request({ type: "stop", sessionId: session.id });
			await writeFile(join(cwd, "AGENTS.md"), "changed-while-stopped");
			await client.request({ type: "open", sessionId: session.id });
			await client.request({ type: "prompt", sessionId: session.id, content: "reopened", requestId: "reopened" });
			await until(() => app.catalog.search("Echo reopened").messages.length === 1);
			assert(String(sections(active, session.id)?.["agents-md"]).includes("changed-while-stopped"));
		} finally {
			await client?.close();
			await app.close();
			await rm(directory, { recursive: true, force: true });
		}
	},
);
