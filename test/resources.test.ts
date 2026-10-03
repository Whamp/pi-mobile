import assert from "node:assert/strict";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ProviderHeaders } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { parseRequest } from "../src/server/requests.ts";
import { Resources } from "../src/shared/resources.ts";
import { until } from "./client.ts";

const messages = [{ role: "user" as const, content: "hello", timestamp: 1 }];
const config = (mode: string) => ({
	providers: {
		faux: {
			baseUrl: "http://unused.test",
			apiKey: "fallback-secret",
			authHeader: true,
			headers: { "X-Mode": mode },
			compat: { supportsDeveloperRole: false, openRouterRouting: { order: ["one"] } },
			models: [
				{
					id: "faux-extra",
					api: "faux",
					name: "Extra",
					reasoning: true,
					inputLimits: { images: { resize: { maxWidth: 640, maxHeight: 480 } } },
					compat: { openRouterRouting: { allow_fallbacks: false } },
					headers: { "X-Model": "$MODEL_HEADER" },
				},
			],
			modelOverrides: {
				"faux-extra": {
					cost: { input: 5 },
					contextWindow: 8000,
					inputLimits: { images: { resize: { maxWidth: 320 } } },
				},
			},
		},
	},
});

test("model composition resolves scoped credentials/headers and freezes in-flight request configuration", async () => {
	const directory = await mkdtemp(join(tmpdir(), "mobile-models-"));
	const seen: { headers?: ProviderHeaders; baseUrl: string }[] = [];
	const started = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	let hold = false;
	const resources = new Resources({
		directory,
		pollMs: 30,
		createModels: (credentials) => {
			const models = createModels({ credentials });
			const faux = fauxProvider({ api: "faux" });
			models.setProvider({
				...faux.provider,
				auth: {
					apiKey: {
						name: "Fixture",
						resolve: async (input) => {
							if (hold) {
								started.resolve();
								await finish.promise;
							}
							return {
								auth: { apiKey: input.credential?.key ?? "ambient" },
								env: input.credential?.env,
								source: "fixture",
							};
						},
					},
				},
				streamSimple(model, context, options) {
					seen.push({ headers: options?.headers, baseUrl: model.baseUrl });
					faux.appendResponses([fauxAssistantMessage("ok")]);
					return faux.provider.streamSimple(model, context, options);
				},
			});
			return models;
		},
	});
	try {
		await resources.credentials.modify("faux", async () => ({
			type: "api_key",
			key: "$KEY",
			env: { KEY: "stored-secret", MODEL_HEADER: "scoped-header" },
		}));
		await writeFile(join(directory, "models.json"), JSON.stringify(config("old")));
		await resources.start();
		const model = resources.models.getModel("faux", "faux-extra");
		assert(model);
		assert.equal(model.cost.input, 5);
		assert.equal(model.contextWindow, 8000);
		assert.equal(model.inputLimits?.images?.resize?.maxWidth, 320);
		assert.equal(model.inputLimits?.images?.resize?.maxHeight, 480);
		assert.deepEqual((model.compat as { openRouterRouting?: unknown }).openRouterRouting, {
			order: ["one"],
			allow_fallbacks: false,
		});
		const snapshot = JSON.stringify(resources.snapshot());
		assert(!snapshot.includes("stored-secret") && !snapshot.includes("fallback-secret"));
		hold = true;
		const pending = resources.models.completeSimple(model, { messages });
		await started.promise;
		await writeFile(join(directory, "models.json"), JSON.stringify(config("new")));
		await resources.reload(true);
		hold = false;
		finish.resolve();
		assert.equal((await pending).stopReason, "stop");
		assert.equal(seen[0].headers?.["X-Mode"], "old");
		assert.equal(seen[0].headers?.Authorization, "Bearer stored-secret");
		assert.equal(seen[0].headers?.["X-Model"], "scoped-header");
		const nextModel = resources.models.getModel("faux", "faux-extra");
		assert(nextModel);
		await resources.models.completeSimple(
			nextModel,
			{ messages },
			{ headers: { "x-mode": "explicit" }, transformHeaders: (headers) => ({ ...headers, "X-Transform": "last" }) },
		);
		assert.equal(seen[1].headers?.["x-mode"], "explicit");
		assert.equal(seen[1].headers?.["X-Transform"], "last");
		await resources.models.completeSimple(nextModel, { messages });
		assert.equal(seen[2].headers?.["X-Mode"], "new");
		assert.equal(seen[2].baseUrl, "http://unused.test");
	} finally {
		hold = false;
		finish.resolve();
		await resources.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("resource polling observes creation/atomic replacement/deletion and retains valid settings/models/auth", async () => {
	const directory = await mkdtemp(join(tmpdir(), "mobile-resources-"));
	const resources = new Resources({ directory, fake: true, pollMs: 25 });
	try {
		await resources.start();
		const policy = resources.harnessSettings();
		assert.deepEqual(resources.settings, {});
		await writeFile(join(directory, "settings.json"), '{"stream":{"timeoutMs":1234},"toolExecution":"sequential"}');
		await until(() => resources.settings.toolExecution === "sequential");
		const pinned = policy.stream;
		assert.equal(pinned?.timeoutMs, 1234);
		await writeFile(join(directory, "replacement"), '{"stream":{"timeoutMs":999},"thinkingLevel":"high"}');
		await rename(join(directory, "replacement"), join(directory, "settings.json"));
		await until(() => resources.settings.thinkingLevel === "high");
		assert.equal(policy.stream?.timeoutMs, 999);
		assert.equal(pinned?.timeoutMs, 1234);
		await writeFile(join(directory, "settings.json"), '{"thinkingLevel":"not-valid","secret":"must-not-leak"}');
		await until(() => resources.resourceErrors.some((error) => error.resource === "settings"));
		assert.equal(resources.settings.thinkingLevel, "high");
		assert(!JSON.stringify(resources.snapshot()).includes("must-not-leak"));
		await resources.saveSettings({ thinkingLevel: "medium" });
		assert.equal(resources.settings.thinkingLevel, "medium");
		assert.equal(resources.resourceErrors.length, 0);
		assert.throws(
			() =>
				parseRequest({
					id: "bad",
					action: { type: "setSettings", settings: { credentials: "never-in-settings" } },
				}),
			/Invalid settings/,
		);
		await writeFile(
			join(directory, "models.json"),
			JSON.stringify({
				providers: { faux: { modelOverrides: { "faux-1": { name: "Updated", maxTokens: 1000 } } } },
			}),
		);
		await until(() => resources.models.getModel("faux", "faux-1")?.name === "Updated");
		await writeFile(join(directory, "models.json"), '{"providers":{"fake":{"apiKey":"must-not-leak"}}');
		await until(() => resources.resourceErrors.some((error) => error.resource === "models"));
		assert.equal(resources.models.getModel("faux", "faux-1")?.name, "Updated");
		await resources.credentials.modify("custom", async () => ({ type: "api_key", key: "credential-secret" }));
		await until(() => resources.snapshot().credentials.some((credential) => credential.providerId === "custom"));
		await writeFile(join(directory, "auth.json"), "{credential-secret-invalid");
		await until(() => resources.resourceErrors.some((error) => error.resource === "credentials"));
		assert(resources.snapshot().credentials.some((credential) => credential.providerId === "custom"));
		assert(!JSON.stringify(resources.snapshot()).includes("credential-secret"));
		await rm(join(directory, "models.json"));
		await rm(join(directory, "settings.json"));
		await rm(join(directory, "auth.json"));
		await until(
			() =>
				resources.resourceErrors.length === 0 &&
				resources.models.getModel("faux", "faux-1")?.name !== "Updated" &&
				resources.snapshot().credentials.length === 0,
		);
		assert.deepEqual(resources.settings, {});
	} finally {
		await resources.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("custom models dispatch through the real OpenAI-compatible implementation to a local fixture only", async () => {
	const directory = await mkdtemp(join(tmpdir(), "mobile-local-model-"));
	let received: { authorization?: string; custom?: string; body?: unknown } = {};
	const server = createServer((request, response) => {
		let body = "";
		request.on("data", (chunk: Buffer) => {
			body += chunk.toString();
		});
		request.on("end", () => {
			received = {
				authorization: request.headers.authorization,
				custom: String(request.headers["x-fixture"]),
				body: JSON.parse(body) as unknown,
			};
			response.writeHead(200, { "Content-Type": "text/event-stream" });
			response.end(
				'data: {"id":"local","object":"chat.completion.chunk","created":1,"model":"fixture","choices":[{"index":0,"delta":{"role":"assistant","content":"local answer"},"finish_reason":null}]}\n\ndata: {"id":"local","object":"chat.completion.chunk","created":1,"model":"fixture","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
			);
		});
	});
	const resources = new Resources({ directory, fake: true });
	try {
		await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
		const address = server.address();
		assert(address && typeof address !== "string");
		await writeFile(
			join(directory, "models.json"),
			JSON.stringify({
				providers: {
					local: {
						api: "openai-completions",
						baseUrl: `http://127.0.0.1:${address.port}/v1`,
						apiKey: "local-secret",
						authHeader: true,
						headers: { "X-Fixture": "!printf resolved-header" },
						models: [{ id: "fixture" }],
					},
				},
			}),
		);
		await resources.start();
		const model = resources.models.getModel("local", "fixture");
		assert(model);
		const result = await resources.models.completeSimple(model, { messages }, { maxRetries: 0, timeoutMs: 3000 });
		assert.equal(result.stopReason, "stop", result.errorMessage);
		assert(result.content.some((part) => part.type === "text" && part.text === "local answer"));
		assert.equal(received.authorization, "Bearer local-secret");
		assert.equal(received.custom, "resolved-header");
		assert(
			received.body &&
				typeof received.body === "object" &&
				"model" in received.body &&
				received.body.model === "fixture",
		);
		assert(!JSON.stringify(resources.snapshot()).includes("local-secret"));
	} finally {
		await resources.close();
		server.closeAllConnections();
		await new Promise<void>((done) => server.close(() => done()));
		await rm(directory, { recursive: true, force: true });
	}
});
