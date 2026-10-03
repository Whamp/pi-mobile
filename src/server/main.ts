import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createApp } from "./app.ts";
import { parseAllowedHosts } from "./hosts.ts";

const port = Number(process.env.PORT ?? "8787");
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid PORT");
const provider = process.env.PI_MOBILE_PROVIDER;
const modelId = process.env.PI_MOBILE_MODEL;
if (Boolean(provider) !== Boolean(modelId)) throw new Error("Set both PI_MOBILE_PROVIDER and PI_MOBILE_MODEL");
const allowedHosts = parseAllowedHosts(process.env.PI_MOBILE_ALLOWED_HOSTS);
const dev = process.env.PI_MOBILE_DEV === "1";
const resume: unknown = dev ? JSON.parse(process.env.PI_MOBILE_DEV_RESUME ?? "[]") : [];
if (!Array.isArray(resume) || !resume.every((id) => typeof id === "string")) throw new Error("Invalid dev resume list");
const app = await createApp({
	web: true,
	allowedHosts,
	directory: process.env.PI_MOBILE_DATA_DIR,
	fake: process.env.PI_MOBILE_FAKE === "1",
	defaultModel: provider && modelId ? { provider, modelId } : undefined,
});
if (allowedHosts[0]) {
	// Keep the sign-in token private: never log it or put it in a URL.
	await rm(join(app.catalog.directory, "owner-link.txt"), { force: true });
	await writeFile(join(app.catalog.directory, "owner-token.txt"), `${app.ownerAccess.issueToken()}\n`, {
		mode: 0o600,
	});
}
if (dev) {
	app.workers.subscribe((event) => {
		if (event.type === "worker" && process.connected)
			process.send?.({ type: "dev-worker", sessionId: event.sessionId, running: event.status.running }, () => {});
	});
	// Do not leave an orphan server if the supervisor dies.
	process.once("disconnect", () => {
		void app.close();
	});
}
function shutdown(): void {
	void app.close().finally(() => {
		// A disconnect listener refs Node's IPC channel. Release it after draining
		// shutdown, otherwise the supervisor must SIGKILL an already-closed server.
		if (dev && process.connected) process.disconnect();
	});
}
app.http.on("error", (error) => {
	console.error(error.message);
	process.exitCode = 1;
	shutdown();
});
app.http.listen(port, "127.0.0.1", () => {
	const address = app.http.address();
	if (address && typeof address !== "string") console.log(`Pi Mobile: http://127.0.0.1:${address.port}`);
	if (dev)
		void (async () => {
			for (const id of resume) {
				try {
					if (app.catalog.get(id).archivedAt === null) await app.workers.open(id);
				} catch {
					console.error(`Dev: could not resume session ${id}`);
				}
			}
		})();
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, shutdown);
