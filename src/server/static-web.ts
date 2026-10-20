import { readFile } from "node:fs/promises";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const contentTypes: Record<string, string> = {
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".woff2": "font/woff2",
};

export async function createWeb(_http: Server, nonce: string, _remoteHosts: readonly string[] = []) {
	const directory = process.env.PI_MOBILE_WEB_DIR ?? fileURLToPath(new URL("../../web", import.meta.url));
	const index = (await readFile(join(directory, "index.html"), "utf8")).replaceAll("__P2W_NONCE__", nonce);
	function handle(request: IncomingMessage, response: ServerResponse): void {
		const path = new URL(request.url ?? "/", "http://localhost").pathname;
		if (path === "/" || /^\/s\/[a-f\d-]+(?:\/a\/\d+)?$/.test(path)) {
			response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			response.end(request.method === "HEAD" ? undefined : index);
			return;
		}
		if (!/^\/assets\/[a-zA-Z0-9._-]+$/.test(path)) {
			response.writeHead(404);
			response.end("Not found");
			return;
		}
		void readFile(join(directory, path.slice(1)))
			.then((body) => {
				response.writeHead(200, { "Content-Type": contentTypes[extname(path)] ?? "application/octet-stream" });
				response.end(request.method === "HEAD" ? undefined : body);
			})
			.catch(() => {
				response.writeHead(404);
				response.end("Not found");
			});
	}
	return { handle, close: async () => {} };
}
