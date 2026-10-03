import { createApp } from "./app.ts";
import { parseAllowedHosts } from "./hosts.ts";

const port = Number(process.env.PORT ?? "8787");
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid PORT");
const provider = process.env.PI_MOBILE_PROVIDER;
const modelId = process.env.PI_MOBILE_MODEL;
if (Boolean(provider) !== Boolean(modelId)) throw new Error("Set both PI_MOBILE_PROVIDER and PI_MOBILE_MODEL");
const app = await createApp({
	web: true,
	allowedHosts: parseAllowedHosts(process.env.PI_MOBILE_ALLOWED_HOSTS),
	directory: process.env.PI_MOBILE_DATA_DIR,
	fake: process.env.PI_MOBILE_FAKE === "1",
	defaultModel: provider && modelId ? { provider, modelId } : undefined,
});
app.http.on("error", (error) => {
	console.error(error.message);
	process.exitCode = 1;
	void app.close();
});
app.http.listen(port, "127.0.0.1", () => {
	const address = app.http.address();
	if (address && typeof address !== "string") console.log(`Pi Mobile: http://127.0.0.1:${address.port}`);
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.once(signal, () => {
		void app.close();
	});
}
