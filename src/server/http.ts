import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { type RequestOrigin, requestOrigin } from "./hosts.ts";

const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pi Mobile</title>
<style>
:root{color-scheme:dark;font-family:system-ui,sans-serif;background:#111318;color:#eef0f6}
body{margin:0;padding:24px}main{max-width:640px;margin:40px auto}
h1{font-size:32px;letter-spacing:-1px;margin-bottom:8px}
p{line-height:1.6;color:#b6bdcd}.card{padding:24px;border:1px solid #303644;border-radius:18px;background:#191d26;margin-top:24px}
.badge{display:inline-block;padding:6px 12px;border-radius:99px;background:#17392d;color:#99e5bf;font-size:14px}
code{color:#c4b5fd}
</style></head>
<body><main><h1>Pi Mobile</h1><span class="badge">Local server running</span>
<div class="card"><h2>A little home for Pi</h2>
<p>This is the server placeholder, not the final UI.</p>
<p>Session workers and search are available through the WebSocket API.</p>
<p>The chat UI and provider login are not implemented yet.</p>
<p>Provider login will initially be available only through the localhost UI.</p>
</div></main></body></html>`;

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

export function cookieName(port: number): string {
	return `pi_mobile_${port}`;
}

export function createMobileServer(
	token?: string,
	web?: { nonce: string; handle: Handler },
	upload?: Handler,
	remoteHosts: readonly string[] = [],
	gate?: (request: IncomingMessage, response: ServerResponse, target: RequestOrigin) => boolean,
	authorizeUpload?: (request: IncomingMessage) => boolean,
) {
	return createServer((req, res) => {
		const target = requestOrigin(req, remoteHosts);
		const port = req.socket.localPort ?? 0;
		const socketOrigin = target?.origin.replace(/^http/, "ws") ?? "";
		res.setHeader("Cache-Control", "no-store");
		res.setHeader("X-Content-Type-Options", "nosniff");
		res.setHeader("Referrer-Policy", "no-referrer");
		res.setHeader(
			"Content-Security-Policy",
			`default-src 'none'; script-src 'self' ${web ? `'nonce-${web.nonce}'` : ""}; connect-src 'self' ${socketOrigin}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
		);
		// Reject unknown hosts (DNS rebinding) and cross-origin browser requests.
		if (!target) {
			res.writeHead(403);
			res.end("Localhost only");
			return;
		}
		if (req.headers.origin && req.headers.origin !== target.origin) {
			res.writeHead(403);
			res.end("Invalid origin");
			return;
		}
		if (gate?.(req, res, target)) return;
		// State-changing requests need the local cookie and an exact same-origin
		// Origin header; a cross-site form cannot satisfy either.
		if (req.method === "POST" && upload && req.url?.startsWith("/upload?")) {
			const cookies = req.headers.cookie?.split(";").map((part) => part.trim()) ?? [];
			if (
				!(authorizeUpload ? authorizeUpload(req) : token && cookies.includes(`${cookieName(port)}=${token}`)) ||
				!req.headers.origin
			) {
				res.writeHead(403);
				res.end("Forbidden");
				return;
			}
			upload(req, res);
			return;
		}
		if (req.method !== "GET" && req.method !== "HEAD") {
			res.writeHead(405, { Allow: "GET, HEAD" });
			res.end();
			return;
		}
		if (req.url === "/" && token && !target.remote && req.headers["sec-fetch-site"] !== "cross-site") {
			const secure = target.remote ? "; Secure" : "";
			res.setHeader("Set-Cookie", `${cookieName(port)}=${token}; HttpOnly; SameSite=Strict; Path=/${secure}`);
		}
		if (web && req.url !== "/health") {
			web.handle(req, res);
			return;
		}
		if (req.url === "/") {
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end(req.method === "HEAD" ? undefined : page);
		} else if (req.url === "/health") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(req.method === "HEAD" ? undefined : JSON.stringify({ ok: true, name: "pi-mobile" }));
		} else {
			res.writeHead(404);
			res.end("Not found");
		}
	});
}
