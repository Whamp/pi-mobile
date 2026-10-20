import { readFile } from "node:fs/promises";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

export async function createWeb(http: Server, nonce: string, remoteHosts: readonly string[] = []) {
	const root = fileURLToPath(new URL("../../", import.meta.url));
	const vite = await createServer({
		configFile: false,
		root,
		appType: "custom",
		plugins: [react()],
		envDir: false,
		envPrefix: "PI_MOBILE_PUBLIC_",
		html: { cspNonce: nonce },
		server: {
			watch: { ignored: ["**/android/.cache/**", "**/android/.generated/**", "**/android/**/build/**"] },
			middlewareMode: true,
			// Our server validates Host first; Vite repeats the check for tunnel hosts.
			allowedHosts: remoteHosts.map((host) => host.replace(/:\d+$/, "")),
			// The HMR client connects to the page's own host and port.
			hmr: { server: http, path: "/__vite_hmr" },
			fs: {
				strict: true,
				allow: [root],
				deny: [
					"**/.git/**",
					"**/.env*",
					"**/auth.json",
					"**/models.json",
					"**/models-store.json",
					"**/device.json",
					"**/owner-key",
					"**/shares.sqlite*",
					"**/owner-token.txt",
					"**/*.sqlite*",
				],
			},
		},
	});
	function handle(request: IncomingMessage, response: ServerResponse): void {
		const path = new URL(request.url ?? "/", "http://localhost").pathname;
		if (path === "/" || /^\/s\/[a-f\d-]+(?:\/a\/\d+)?$/.test(path)) {
			void (async () => {
				const html = await vite.transformIndexHtml(
					"/",
					await readFile(new URL("../../index.html", import.meta.url), "utf8"),
				);
				response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
				response.end(request.method === "HEAD" ? undefined : html);
			})().catch(() => {
				response.writeHead(500);
				response.end("Could not load the UI");
			});
		} else
			vite.middlewares(request, response, () => {
				response.writeHead(404);
				response.end("Not found");
			});
	}
	return { handle, close: () => vite.close(), vite };
}
