import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import type { RequestOrigin } from "./hosts.ts";
import { cookieName } from "./http.ts";

function signInPage(nonce: string): string {
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Pi · Sign in</title>
<style>body{font:16px system-ui;background:#151413;color:#ecebe8;max-width:440px;margin:12vh auto;padding:24px}label{display:block;margin-bottom:8px}input{box-sizing:border-box;width:100%;font:16px monospace;background:#262422;color:#ecebe8;border:1px solid #49443e;border-radius:12px;padding:14px}button{font:inherit;border:0;border-radius:14px;background:#ef8256;padding:14px 22px;cursor:pointer;margin-top:16px}p{line-height:1.6;color:#aaa}</style></head>
<body><h1>Sign in to Pi</h1><p>On the phone, open Pi's sidebar and choose <strong>Sign in another device</strong>. Copy the one-time token and paste it here.</p>
<form id="sign-in"><label for="token">One-time token</label><input id="token" type="password" autocomplete="off" spellcheck="false" required><button id="submit" type="submit">Sign in</button></form>
<p id="status" role="status"></p><p>This grants full owner access, including shell commands. Tokens expire after ten minutes and work once.</p>
<script nonce="${nonce}">
document.getElementById("sign-in").onsubmit=async(event)=>{
 event.preventDefault();const button=document.getElementById("submit");const status=document.getElementById("status");button.disabled=true;status.textContent="Signing in…";
 try{const r=await fetch("/owner/claim",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({token:document.getElementById("token").value.trim()})});if(!r.ok)throw new Error("Invalid, expired or already-used token. Generate a fresh one on the phone.");location.replace("/");}
 catch(e){status.textContent=e.message;button.disabled=false;}
};
</script></body></html>`;
}

export class OwnerAccess {
	readonly token: string;
	private readonly invitations = new Map<string, number>();
	private constructor(token: string) {
		this.token = token;
	}

	static async open(directory: string): Promise<OwnerAccess> {
		const path = join(directory, "owner-key");
		let token: string;
		try {
			token = (await readFile(path, "utf8")).trim();
		} catch (error) {
			if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
			token = randomBytes(32).toString("hex");
			await writeFile(path, token, { mode: 0o600, flag: "wx" });
		}
		if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Invalid owner key");
		return new OwnerAccess(token);
	}

	issueToken(): string {
		for (const [hash, expires] of this.invitations) if (expires <= Date.now()) this.invitations.delete(hash);
		if (this.invitations.size >= 32) this.invitations.delete(this.invitations.keys().next().value ?? "");
		const token = randomBytes(32).toString("hex");
		this.invitations.set(createHash("sha256").update(token).digest("hex"), Date.now() + 10 * 60_000);
		return token;
	}

	authorized(request: IncomingMessage): boolean {
		const port = request.socket.localPort ?? 0;
		return (request.headers.cookie?.split(";").map((part) => part.trim()) ?? []).includes(
			`${cookieName(port)}=${this.token}`,
		);
	}

	/** Return true when this request was handled, otherwise proceed to the app. */
	gate(request: IncomingMessage, response: ServerResponse, target: RequestOrigin, nonce: string): boolean {
		const path = (request.url ?? "/").split("?")[0];
		if (path === "/owner-token" && !target.remote && request.method === "GET") {
			if (!this.authorized(request) || request.headers["sec-fetch-site"] === "cross-site") {
				response.writeHead(403);
				response.end("Forbidden");
				return true;
			}
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(JSON.stringify({ token: this.issueToken() }));
			return true;
		}
		if (path === "/owner" && (request.method === "GET" || request.method === "HEAD")) {
			response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			response.end(request.method === "HEAD" ? undefined : signInPage(nonce));
			return true;
		}
		if (path === "/owner/claim" && request.method === "POST") {
			if (request.headers.origin !== target.origin) {
				response.writeHead(403);
				response.end("Invalid origin");
				return true;
			}
			void this.claim(request, response, target).catch(() => {
				if (!response.headersSent) {
					response.writeHead(400);
					response.end("Invalid sign-in request");
				}
			});
			return true;
		}
		if (!target.remote || this.authorized(request) || (path === "/health" && request.method === "GET")) return false;
		response.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
		response.end(request.method === "HEAD" ? undefined : signInPage(nonce));
		return true;
	}

	private async claim(request: IncomingMessage, response: ServerResponse, target: RequestOrigin): Promise<void> {
		let body = "";
		for await (const chunk of request) {
			body += String(chunk);
			if (body.length > 1024) {
				response.writeHead(413);
				response.end("Too large");
				request.destroy();
				return;
			}
		}
		const value: unknown = JSON.parse(body);
		const token = value && typeof value === "object" && "token" in value ? value.token : undefined;
		const hash = typeof token === "string" ? createHash("sha256").update(token.trim()).digest("hex") : "";
		const expires = this.invitations.get(hash);
		this.invitations.delete(hash);
		if (!expires || expires <= Date.now()) {
			response.writeHead(403);
			response.end("Invalid one-time token");
			return;
		}
		response.writeHead(200, {
			"Set-Cookie": `${cookieName(target.port)}=${this.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${target.remote ? "; Secure" : ""}`,
			"Content-Type": "application/json",
		});
		response.end('{"ok":true}');
	}
}
