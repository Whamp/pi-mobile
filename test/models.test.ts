import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import { createApp } from "../src/server/app.ts";
import { P2W_MODELS } from "../src/shared/model-policy.ts";
import { createMobileModels } from "../src/shared/models.ts";
import type { SessionSummary } from "../src/shared/protocol.ts";
import { Client } from "./client.ts";

test("p2w's five exact IDs resolve in pi-ai 1.3.0 without custom model fallbacks", () => {
	const models = createMobileModels(false);
	const resolved = P2W_MODELS.map((choice) => {
		const model = models.getModel(choice.provider, choice.modelId);
		assert(model, `${choice.provider}/${choice.modelId} is in the shipped catalog`);
		const thinkingLevels = getSupportedThinkingLevels(model);
		if (choice.thinkingLevel) assert(thinkingLevels.includes(choice.thinkingLevel));
		return { ...choice, name: model.name, api: model.api, contextWindow: model.contextWindow, thinkingLevels };
	});
	assert.equal(resolved.length, 5);
	assert.deepEqual(
		resolved.map((model) => `${model.provider}/${model.modelId}`),
		[
			"openai-codex/gpt-6.1-sol",
			"openai-codex/gpt-6-luna",
			"zai/glm-5.3-flash",
			"zai/glm-5.3",
			"kimi-coding/k3-256k",
		],
	);
	console.log(JSON.stringify({ piAiVersion: "1.3.0", customFallbacks: [], models: resolved }, null, 2));
});

test("p2w offers only Will's catalog and creates Sol high sessions by default", async () => {
	const previousProfile = process.env.PI_MOBILE_PROFILE;
	process.env.PI_MOBILE_PROFILE = "p2w";
	const directory = await mkdtemp(join(tmpdir(), "p2w-model-policy-"));
	let app: Awaited<ReturnType<typeof createApp>> | undefined;
	let client: Client | undefined;
	try {
		app = await createApp({ directory });
		await new Promise<void>((done) => app?.http.listen(0, "127.0.0.1", done));
		const address = app.http.address();
		assert(address && typeof address !== "string");
		client = await Client.connect(`http://127.0.0.1:${address.port}`);
		assert.deepEqual(
			app.resources
				.snapshot()
				.models.map((model) => `${model.provider}/${model.modelId}`)
				.sort(),
			[
				"openai-codex/gpt-6.1-sol",
				"openai-codex/gpt-6-luna",
				"zai/glm-5.3-flash",
				"zai/glm-5.3",
				"kimi-coding/k3-256k",
			].sort(),
		);
		assert.deepEqual(
			app.resources
				.snapshot()
				.providers.map((provider) => provider.id)
				.sort(),
			["kimi-coding", "openai-codex", "zai"],
		);
		const session = await client.request<SessionSummary>({ type: "create", cwd: directory });
		assert.deepEqual(session.model, { provider: "openai-codex", modelId: "gpt-6.1-sol" });
		assert.equal(session.thinkingLevel, "high");
		await assert.rejects(
			client.request({
				type: "configure",
				sessionId: session.id,
				model: { provider: "kimi-coding", modelId: "k3" },
			}),
			/not offered/,
		);
	} finally {
		await client?.close();
		await app?.close();
		await rm(directory, { recursive: true, force: true });
		if (previousProfile === undefined) delete process.env.PI_MOBILE_PROFILE;
		else process.env.PI_MOBILE_PROFILE = previousProfile;
	}
});
