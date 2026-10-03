import { appendFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { Provider } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { FileCredentials } from "../../src/shared/credentials.ts";

const [path, counter] = process.argv.slice(2);
if (!path || !counter || !process.send) throw new Error("Expected credential fixture arguments and IPC");
const provider: Provider = {
	id: "test-oauth",
	name: "Test OAuth",
	getModels: () => [],
	auth: {
		oauth: {
			name: "Test OAuth",
			login: async () => {
				throw new Error("Unused login");
			},
			refresh: async (credential, signal) => {
				await delay(150, undefined, { signal });
				await appendFile(counter, "refresh\n");
				return {
					...credential,
					access: "refreshed-access",
					refresh: "rotated-refresh",
					expires: Date.now() + 600_000,
				};
			},
			toAuth: async (credential) => ({ apiKey: credential.access }),
		},
	},
	stream: () => {
		throw new Error("No real provider calls");
	},
	streamSimple: () => {
		throw new Error("No real provider calls");
	},
};
const models = createModels({ credentials: new FileCredentials(path) });
models.setProvider(provider);
process.send({ type: "ready" });
process.once("message", () => {
	void models.getAuth(provider.id).then(
		(auth) => {
			process.send?.({ type: "done", ok: auth?.auth.apiKey === "refreshed-access" }, () => process.disconnect());
		},
		() => {
			process.send?.({ type: "done", ok: false }, () => process.disconnect());
		},
	);
});
