import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { GuestAccess, ShareInfo, ShareSettings } from "../shared/sharing.ts";
import type { Catalog } from "./catalog.ts";
import type { RequestOrigin } from "./hosts.ts";

const hash = (secret: string) => createHash("sha256").update(secret).digest("hex");
const escapeHtml = (value: string) =>
	value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

export class Shares {
	private readonly db: DatabaseSync;
	private readonly catalog: Catalog;
	constructor(catalog: Catalog) {
		this.catalog = catalog;
		const path = join(catalog.directory, "shares.sqlite");
		this.db = new DatabaseSync(path);
		chmodSync(path, 0o600);
		this.db.exec(`PRAGMA journal_mode=WAL;
			CREATE TABLE IF NOT EXISTS shares(id TEXT PRIMARY KEY, sessionId TEXT UNIQUE NOT NULL, token TEXT NOT NULL, canSend INTEGER NOT NULL, canStop INTEGER NOT NULL, expiresAt INTEGER) STRICT;
			CREATE TABLE IF NOT EXISTS guests(id TEXT PRIMARY KEY, shareId TEXT NOT NULL, name TEXT NOT NULL, secretHash TEXT NOT NULL, muted INTEGER NOT NULL DEFAULT 0, removed INTEGER NOT NULL DEFAULT 0, lastSeen INTEGER NOT NULL) STRICT;`);
	}

	get(sessionId: string): ShareInfo | undefined {
		const row = this.db.prepare("SELECT * FROM shares WHERE sessionId=?").get(sessionId);
		if (!row) return undefined;
		return {
			id: String(row.id),
			token: String(row.token),
			canSend: row.canSend === 1,
			canStop: row.canStop === 1,
			expiresAt: row.expiresAt === null ? null : Number(row.expiresAt),
			guests: this.db
				.prepare("SELECT id,name,muted,removed,lastSeen FROM guests WHERE shareId=? ORDER BY lastSeen DESC")
				.all(String(row.id))
				.map((guest) => ({
					id: String(guest.id),
					name: String(guest.name),
					muted: guest.muted === 1,
					removed: guest.removed === 1,
					lastSeen: Number(guest.lastSeen),
				})),
		};
	}

	set(sessionId: string, settings: ShareSettings, reset: boolean): ShareInfo {
		this.catalog.get(sessionId);
		const old = this.get(sessionId);
		if (!old || reset) {
			this.db
				.prepare(
					"INSERT INTO shares(id,sessionId,token,canSend,canStop,expiresAt) VALUES(?,?,?,?,?,?) ON CONFLICT(sessionId) DO UPDATE SET id=excluded.id,token=excluded.token,canSend=excluded.canSend,canStop=excluded.canStop,expiresAt=excluded.expiresAt",
				)
				.run(
					randomUUID(),
					sessionId,
					randomBytes(32).toString("base64url"),
					Number(settings.canSend),
					Number(settings.canStop),
					settings.expiresAt,
				);
		} else
			this.db
				.prepare("UPDATE shares SET canSend=?,canStop=?,expiresAt=? WHERE sessionId=?")
				.run(Number(settings.canSend), Number(settings.canStop), settings.expiresAt, sessionId);
		const current = this.get(sessionId);
		if (!current) throw new Error("Share could not be saved");
		return current;
	}
	revoke(sessionId: string): void {
		this.db.prepare("DELETE FROM shares WHERE sessionId=?").run(sessionId);
	}
	guest(sessionId: string, id: string, muted: boolean, removed: boolean): void {
		const share = this.get(sessionId);
		if (!share) throw new Error("No active share");
		this.db
			.prepare("UPDATE guests SET muted=?,removed=? WHERE id=? AND shareId=?")
			.run(Number(muted), Number(removed), id, share.id);
	}

	private active(token: string) {
		if (!/^[\w-]{43}$/.test(token)) return undefined;
		const row = this.db
			.prepare("SELECT * FROM shares WHERE token=? AND (expiresAt IS NULL OR expiresAt>?)")
			.get(token, Date.now());
		if (!row || this.catalog.get(String(row.sessionId)).archivedAt !== null) return undefined;
		return row;
	}

	access(id: string): GuestAccess | undefined {
		const row = this.db
			.prepare(
				"SELECT guests.*,shares.sessionId,shares.canSend,shares.canStop,shares.expiresAt FROM guests JOIN shares ON shares.id=guests.shareId WHERE guests.id=? AND removed=0 AND (expiresAt IS NULL OR expiresAt>?)",
			)
			.get(id, Date.now());
		if (!row || this.catalog.get(String(row.sessionId)).archivedAt !== null) return undefined;
		return {
			kind: "guest",
			id,
			name: String(row.name),
			shareId: String(row.shareId),
			sessionId: String(row.sessionId),
			canSend: row.canSend === 1 && row.muted !== 1,
			canStop: row.canStop === 1 && row.muted !== 1,
			expiresAt: row.expiresAt === null ? null : Number(row.expiresAt),
		};
	}

	fromRequest(request: IncomingMessage): GuestAccess | undefined {
		const value =
			(request.headers.cookie ?? "")
				.split(";")
				.map((part) => part.trim())
				.find((part) => part.startsWith(`pi_mobile_guest_${request.socket.localPort}=`))
				?.split("=")[1] ?? "";
		const [id, secret] = value.split(".");
		if (!id || !secret || secret.length !== 64) return undefined;
		const row = this.db.prepare("SELECT secretHash FROM guests WHERE id=?").get(id);
		return row?.secretHash === hash(secret) ? this.access(id) : undefined;
	}

	/** Join pages don't load the app or expose any other session. */
	http(
		request: IncomingMessage,
		response: ServerResponse,
		target: RequestOrigin,
		nonce: string,
		owner: boolean,
	): boolean {
		const path = (request.url ?? "/").split("?")[0] ?? "/";
		const match = /^\/join\/([\w-]{43})$/.exec(path);
		if (match && (request.method === "GET" || request.method === "HEAD")) {
			const share = this.active(match[1] ?? "");
			if (!share) {
				response.writeHead(410);
				response.end("This share has ended.");
				return true;
			}
			const guest = this.fromRequest(request);
			if (owner || guest?.shareId === share.id) {
				response.writeHead(303, { Location: `/s/${share.sessionId}` });
				response.end();
				return true;
			}
			const title = escapeHtml(this.catalog.get(String(share.sessionId)).title);
			response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			response.end(
				request.method === "HEAD"
					? undefined
					: `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Join shared session</title><style>body{font:16px system-ui;max-width:440px;margin:12vh auto;padding:24px;background:#151413;color:#ecebe8}input,button{font:inherit;padding:14px;border-radius:12px;box-sizing:border-box;width:100%;margin-top:12px}button{background:#ef8256;border:0}p{line-height:1.6}</style><h1>${title}</h1><p>A session has been shared with you. Enter your name to join. Names are not verified.</p><form id="join"><input id="name" aria-label="Your name" maxlength="40" required autocomplete="nickname"><button>Join session</button></form><p id="status" role="status"></p><script nonce="${nonce}">document.getElementById("join").onsubmit=async(e)=>{e.preventDefault();try{const r=await fetch("/join",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({token:location.pathname.split("/").pop(),name:document.getElementById("name").value})});const v=await r.json();if(!r.ok)throw new Error(v.error);location.replace("/s/"+v.sessionId);}catch(e){document.getElementById("status").textContent=e.message;}};</script></html>`,
			);
			return true;
		}
		if (path === "/join" && request.method === "POST") {
			if (request.headers.origin !== target.origin) {
				response.writeHead(403);
				response.end("Invalid origin");
				return true;
			}
			void this.join(request, response, target).catch(() => {
				if (!response.headersSent) {
					response.writeHead(400, { "Content-Type": "application/json" });
					response.end('{"error":"Could not join this session."}');
				}
			});
			return true;
		}
		return false;
	}

	private async join(request: IncomingMessage, response: ServerResponse, target: RequestOrigin): Promise<void> {
		const chunks: Buffer[] = [];
		let size = 0;
		for await (const chunk of request) {
			const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			size += bytes.length;
			if (size > 2048) throw new Error("Too large");
			chunks.push(bytes);
		}
		const input: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		if (
			!input ||
			typeof input !== "object" ||
			!("token" in input) ||
			!("name" in input) ||
			typeof input.token !== "string" ||
			typeof input.name !== "string"
		)
			throw new Error("Invalid join");
		const share = this.active(input.token);
		if (!share) throw new Error("Expired share");
		const cookie = (request.headers.cookie ?? "")
			.split(";")
			.map((part) => part.trim())
			.find((part) => part.startsWith(`pi_mobile_guest_${target.port}=`))
			?.split("=")[1];
		if (cookie) {
			const [id, secret] = cookie.split(".");
			const existing = this.db
				.prepare("SELECT shareId,secretHash,muted,removed FROM guests WHERE id=?")
				.get(id ?? "");
			if (existing?.shareId === share.id && secret && existing.secretHash === hash(secret)) {
				if (existing.removed === 1) throw new Error("Guest removed");
				response.writeHead(200, { "Content-Type": "application/json" });
				response.end(JSON.stringify({ sessionId: share.sessionId }));
				return;
			}
		}
		if (Number(this.db.prepare("SELECT count(*) AS n FROM guests WHERE shareId=?").get(String(share.id))?.n) >= 1000)
			throw new Error("Guest limit reached");
		let name = input.name
			.normalize("NFKC")
			.replace(/[\p{C}<>]/gu, "")
			.trim()
			.slice(0, 40);
		if (!name) throw new Error("Choose a guest name");
		const count = Number(
			this.db
				.prepare("SELECT count(*) AS n FROM guests WHERE shareId=? AND (name=? OR name LIKE ?) ")
				.get(String(share.id), name, `${name} (%)`)?.n ?? 0,
		);
		if (count) name = `${name} (${count + 1})`;
		const id = randomUUID();
		const secret = randomBytes(32).toString("hex");
		this.db
			.prepare("INSERT INTO guests(id,shareId,name,secretHash,lastSeen) VALUES(?,?,?,?,?)")
			.run(id, String(share.id), name, hash(secret), Date.now());
		response.writeHead(200, {
			"Content-Type": "application/json",
			"Set-Cookie": `pi_mobile_guest_${target.port}=${id}.${secret}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${target.remote ? "; Secure" : ""}`,
		});
		response.end(JSON.stringify({ sessionId: share.sessionId }));
	}
	seen(id: string): void {
		this.db.prepare("UPDATE guests SET lastSeen=? WHERE id=?").run(Date.now(), id);
	}
	close(): void {
		this.db.close();
	}
}
