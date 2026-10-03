import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createApp } from "../src/server/app.ts";
import type { LoginEvent } from "../src/shared/login-protocol.ts";
import { type ResourceOptions, Resources } from "../src/shared/resources.ts";
import { Client, until } from "./client.ts";

function fixture(
	mode: "interactive" | "callback" | "failure",
	devices: string[],
): NonNullable<ResourceOptions["createModels"]> {
	return (credentials, modelsStore) => {
		const models = createModels({ credentials, modelsStore });
		const faux = fauxProvider({ api: "test-login" });
		let catalog = [...faux.models];
		models.setProvider({
			...faux.provider,
			getModels: () => catalog,
			auth: {
				apiKey: {
					name: "Fixture key",
					login: async (interaction) => ({
						type: "api_key",
						key: await interaction.prompt({ type: "secret", message: "Enter fixture key" }),
					}),
					resolve: async ({ credential }) =>
						credential ? { auth: { apiKey: credential.key }, source: "stored" } : undefined,
				},
				oauth: {
					name: "Fixture OAuth",
					login: async (interaction, options) => {
						devices.push(options?.getDeviceId?.() ?? "");
						interaction.notify({
							type: "auth_url",
							url: "https://example.test/login",
							instructions: "Fixture only",
						});
						if (mode === "failure") throw new Error("secret-that-must-not-be-forwarded");
						if (mode === "callback") {
							const callback = new AbortController();
							const pending = interaction.prompt({
								type: "manual_code",
								message: "Paste callback URL",
								signal: callback.signal,
							});
							void pending.catch(() => {});
							await delay(100, undefined, { signal: interaction.signal });
							callback.abort();
						} else {
							await interaction.prompt({
								type: "select",
								message: "Select account",
								options: [{ id: "account", label: "Fixture account" }],
							});
							await interaction.prompt({ type: "text", message: "Account label" });
							await interaction.prompt({ type: "secret", message: "Password" });
							interaction.notify({
								type: "device_code",
								userCode: "CODE-ONLY",
								verificationUri: "https://example.test/verify",
							});
							await interaction.prompt({ type: "manual_code", message: "Paste authorization code" });
						}
						return {
							type: "oauth",
							access: "private-access-token",
							refresh: "private-refresh-token",
							expires: Date.now() + 600000,
						};
					},
					refresh: async (credential) => credential,
					toAuth: async (credential) => ({ apiKey: credential.access }),
				},
			},
			refreshModels: async (context) => {
				if (context.stored)
					await context.publish({
						update: () => {
							catalog = [...(context.stored?.models ?? [])] as typeof catalog;
						},
					});
				if (!context.allowNetwork) return;
				const extra = { ...faux.models[0], id: "private-model", name: "Private fixture model" };
				await context.publish({
					persist: { models: [...faux.models, extra] },
					update: () => {
						catalog = [...faux.models, extra];
					},
				});
			},
		});
		return models;
	};
}

async function connect(app: Awaited<ReturnType<typeof createApp>>): Promise<Client> {
	await new Promise<void>((done) => app.http.listen(0, "127.0.0.1", done));
	const address = app.http.address();
	assert(address && typeof address !== "string");
	return Client.connect(`http://127.0.0.1:${address.port}`);
}
function events(client: Client): LoginEvent[] {
	return client.events.flatMap((event) => (event.type === "login" ? [event.event] : []));
}

for (const mode of ["interactive", "callback"] as const)
	test(`provider-owned ${mode} login bridges prompts, hides credentials and persists cached catalogs`, async () => {
		const directory = await mkdtemp(join(tmpdir(), "mobile-login-"));
		const devices: string[] = [];
		const makeModels = fixture(mode, devices);
		const app = await createApp({ directory, fake: true, createModels: makeModels });
		const client = await connect(app);
		let other: Client | undefined;
		try {
			const address = app.http.address();
			assert(address && typeof address !== "string");
			other = await Client.connect(`http://127.0.0.1:${address.port}`);
			const { attemptId } = await client.request<{ attemptId: string }>({
				type: "login",
				providerId: "faux",
				authType: "oauth",
			});
			if (mode === "interactive") {
				for (const type of ["select", "text", "secret", "manual_code"] as const) {
					await until(() => events(client).some((event) => event.type === "prompt" && event.prompt.type === type));
					const event = events(client).find((entry) => entry.type === "prompt" && entry.prompt.type === type);
					assert(event?.type === "prompt");
					await assert.rejects(
						other.request({ type: "loginAnswer", attemptId, promptId: event.prompt.id, value: "wrong-owner" }),
						/connection/,
					);
					if (type === "select")
						await assert.rejects(
							client.request({ type: "loginAnswer", attemptId, promptId: event.prompt.id, value: "unlisted" }),
							/listed/,
						);
					await client.request({
						type: "loginAnswer",
						attemptId,
						promptId: event.prompt.id,
						value: type === "select" ? "account" : "private-entered-value",
					});
				}
			}
			await until(() => events(client).some((event) => event.type === "finished" && event.status === "success"));
			assert.equal(events(other).length, 0, "login events belong only to the initiating connection");
			assert(events(client).some((event) => event.type === "promptClosed"));
			assert(!JSON.stringify(client.events).includes("private-access-token"));
			assert(!JSON.stringify(client.events).includes("private-entered-value"));
			assert(
				app.resources
					.snapshot()
					.credentials.some((credential) => credential.providerId === "faux" && credential.type === "oauth"),
			);
			assert(app.resources.models.getModel("faux", "private-model"));
			const reopened = new Resources({ directory, createModels: makeModels });
			try {
				await reopened.start();
				assert(
					reopened.models.getModel("faux", "private-model"),
					"a fresh process can restore the catalog without network",
				);
			} finally {
				await reopened.close();
			}
			assert(devices[0]);
			await client.request({ type: "logout", providerId: "faux" });
			assert.equal(app.resources.snapshot().credentials.length, 0);
			assert.equal(app.resources.models.getModel("faux", "private-model"), undefined);
			await client.request({ type: "login", providerId: "faux", authType: "api_key" });
			await until(
				() =>
					events(client).filter((event) => event.type === "prompt" && event.prompt.type === "secret").length >=
					(mode === "interactive" ? 2 : 1),
			);
			const prompt = events(client).findLast((event) => event.type === "prompt");
			assert(prompt?.type === "prompt");
			await client.request({
				type: "loginAnswer",
				attemptId: prompt.attemptId,
				promptId: prompt.prompt.id,
				value: "private-api-key",
			});
			await until(
				() =>
					events(client).filter((event) => event.type === "finished" && event.status === "success").length === 2,
			);
			assert(!JSON.stringify(client.events).includes("private-api-key"));
			assert((await readFile(join(directory, "device.json"), "utf8")).includes(devices[0]));
		} finally {
			await other?.close();
			await client.close();
			await app.close();
			await rm(directory, { recursive: true, force: true });
		}
	});

test("login cancellation, connection loss, deadlines and failures never publish secrets or commit unfinished credentials", async () => {
	const directory = await mkdtemp(join(tmpdir(), "mobile-login-cancel-"));
	const app = await createApp({
		directory,
		fake: true,
		createModels: fixture("interactive", []),
		loginTimeoutMs: 1500,
	});
	let client: Client | undefined;
	try {
		client = await connect(app);
		let started = await client.request<{ attemptId: string }>({
			type: "login",
			providerId: "faux",
			authType: "oauth",
		});
		await assert.rejects(client.request({ type: "login", providerId: "faux", authType: "api_key" }), /already/);
		await client.request({ type: "cancelLogin", attemptId: started.attemptId });
		const active = client;
		await until(() => events(active).some((event) => event.type === "finished" && event.status === "cancelled"));
		assert.equal(app.resources.snapshot().credentials.length, 0);
		started = await client.request({ type: "login", providerId: "faux", authType: "oauth" });
		await until(
			() => events(active).filter((event) => event.type === "finished" && event.status === "cancelled").length === 2,
		);
		assert.equal(app.resources.snapshot().credentials.length, 0);
		await client.request({ type: "login", providerId: "faux", authType: "oauth" });
		await client.close();
		client = undefined;
		await delay(150);
		assert.equal(app.resources.snapshot().credentials.length, 0);
	} finally {
		await client?.close();
		await app.close();
		await rm(directory, { recursive: true, force: true });
	}
	const failedDirectory = await mkdtemp(join(tmpdir(), "mobile-login-failure-"));
	const failed = await createApp({ directory: failedDirectory, createModels: fixture("failure", []) });
	const failedClient = await connect(failed);
	try {
		await failedClient.request({ type: "login", providerId: "faux", authType: "oauth" });
		await until(() => events(failedClient).some((event) => event.type === "finished" && event.status === "error"));
		assert(!JSON.stringify(failedClient.events).includes("secret-that-must-not-be-forwarded"));
	} finally {
		await failedClient.close();
		await failed.close();
		await rm(failedDirectory, { recursive: true, force: true });
	}
});
