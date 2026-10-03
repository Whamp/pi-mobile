import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelRef } from "@earendil-works/pi-durable";
import type { IndexedMessage, SearchHit, SearchResults, SessionInfo, SubagentInfo } from "../shared/protocol.ts";

export const defaultDataDirectory = join(homedir(), ".pi", "mobile");
const schemaVersion = 2;

export class Catalog {
	readonly directory: string;
	private readonly db: DatabaseSync;

	constructor(directory = defaultDataDirectory) {
		this.directory = directory;
		mkdirSync(join(directory, "sessions"), { recursive: true, mode: 0o700 });
		this.db = new DatabaseSync(join(directory, "catalog.sqlite"));
		this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;");
		const version = this.db.prepare("PRAGMA user_version").get()?.user_version;
		if (version !== 0 && version !== 1 && version !== schemaVersion) {
			this.db.close();
			throw new Error(`Unsupported catalog schema: ${version}`);
		}
		// v2: subagent conversations, recorded so the sidebar lists them while a worker is stopped.
		if (version === 1) this.db.exec("ALTER TABLE sessions ADD COLUMN subagents TEXT NOT NULL DEFAULT '[]'");
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS sessions (
				id TEXT PRIMARY KEY, cwd TEXT NOT NULL, title TEXT NOT NULL,
				titleEdited INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
				archivedAt INTEGER, pinned INTEGER NOT NULL DEFAULT 0,
				model TEXT NOT NULL, thinkingLevel TEXT NOT NULL, indexedThrough INTEGER NOT NULL DEFAULT 0,
				subagents TEXT NOT NULL DEFAULT '[]'
			) STRICT;
			CREATE TABLE IF NOT EXISTS messages (
				rowid INTEGER PRIMARY KEY, sessionId TEXT NOT NULL REFERENCES sessions(id),
				conversationId INTEGER NOT NULL, entryId INTEGER NOT NULL, role TEXT NOT NULL,
				timestamp INTEGER NOT NULL, text TEXT NOT NULL,
				UNIQUE(sessionId, conversationId, entryId)
			) STRICT;
			CREATE VIRTUAL TABLE IF NOT EXISTS message_search USING fts5(text, content='messages', content_rowid='rowid');
			CREATE TRIGGER IF NOT EXISTS messages_insert AFTER INSERT ON messages BEGIN
				INSERT INTO message_search(rowid,text) VALUES (new.rowid,new.text);
			END;
			CREATE TRIGGER IF NOT EXISTS messages_delete AFTER DELETE ON messages BEGIN
				INSERT INTO message_search(message_search,rowid,text) VALUES ('delete',old.rowid,old.text);
			END;
			PRAGMA user_version=${schemaVersion};
		`);
	}

	storagePath(id: string): string {
		this.get(id); // Only catalog IDs can become paths.
		return join(this.directory, "sessions", `${id}.sqlite`);
	}

	create(cwd: string, model: ModelRef, thinkingLevel: ModelThinkingLevel, title?: string): SessionInfo {
		const id = randomUUID();
		const now = Date.now();
		this.db
			.prepare(`INSERT INTO sessions (id,cwd,title,titleEdited,createdAt,updatedAt,model,thinkingLevel)
			VALUES (?,?,?,?,?,?,?,?)`)
			.run(
				id,
				cwd,
				title ?? "New session",
				title === undefined ? 0 : 1,
				now,
				now,
				JSON.stringify(model),
				thinkingLevel,
			);
		return this.get(id);
	}

	private decode(row: Record<string, unknown>): SessionInfo {
		return {
			id: String(row.id),
			cwd: String(row.cwd),
			title: String(row.title),
			createdAt: Number(row.createdAt),
			updatedAt: Number(row.updatedAt),
			archivedAt: row.archivedAt === null ? null : Number(row.archivedAt),
			pinned: row.pinned === 1,
			model: JSON.parse(String(row.model)) as ModelRef,
			thinkingLevel: String(row.thinkingLevel) as ModelThinkingLevel,
			indexedThrough: Number(row.indexedThrough),
			subagents: JSON.parse(String(row.subagents)) as SubagentInfo[],
		};
	}

	get(id: string): SessionInfo {
		const row = this.db.prepare("SELECT * FROM sessions WHERE id=?").get(id);
		if (!row) throw new Error("Session not found");
		return this.decode(row);
	}

	list(archived?: boolean): SessionInfo[] {
		return this.db
			.prepare(`SELECT * FROM sessions
			WHERE (? IS NULL OR (archivedAt IS NOT NULL)=?) ORDER BY cwd,pinned DESC,updatedAt DESC,id`)
			.all(archived === undefined ? null : Number(archived), archived === undefined ? null : Number(archived))
			.map((row) => this.decode(row));
	}

	rename(id: string, title: string): void {
		this.get(id);
		this.db.prepare("UPDATE sessions SET title=?,titleEdited=1 WHERE id=?").run(title, id);
	}

	configure(id: string, model: ModelRef, thinkingLevel: ModelThinkingLevel): void {
		this.get(id);
		this.db
			.prepare("UPDATE sessions SET model=?,thinkingLevel=? WHERE id=?")
			.run(JSON.stringify(model), thinkingLevel, id);
	}

	setSubagents(id: string, subagents: readonly SubagentInfo[]): void {
		this.get(id);
		this.db.prepare("UPDATE sessions SET subagents=? WHERE id=?").run(JSON.stringify(subagents), id);
	}

	pin(id: string, pinned: boolean): void {
		this.get(id);
		this.db.prepare("UPDATE sessions SET pinned=? WHERE id=?").run(Number(pinned), id);
	}

	archive(id: string, archived: boolean): void {
		this.get(id);
		this.db.prepare("UPDATE sessions SET archivedAt=? WHERE id=?").run(archived ? Date.now() : null, id);
	}

	index(id: string, messages: readonly IndexedMessage[], through: number): void {
		this.get(id);
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const insert = this.db.prepare(`INSERT INTO messages
				(sessionId,conversationId,entryId,role,timestamp,text) VALUES (?,?,?,?,?,?)
				ON CONFLICT(sessionId,conversationId,entryId) DO NOTHING`);
			for (const message of messages) {
				insert.run(id, message.conversationId, message.entryId, message.role, message.timestamp, message.text);
			}
			this.db
				.prepare(`UPDATE sessions SET indexedThrough=max(indexedThrough,?),
				updatedAt=max(updatedAt,coalesce((SELECT max(timestamp) FROM messages WHERE sessionId=?),0)) WHERE id=?`)
				.run(through, id, id);
			this.db
				.prepare(`UPDATE sessions SET title=substr(replace(replace(
				(SELECT text FROM messages WHERE sessionId=? AND role='user' ORDER BY entryId LIMIT 1),char(10),' '),char(13),' '),1,100)
				WHERE id=? AND titleEdited=0 AND EXISTS(SELECT 1 FROM messages WHERE sessionId=? AND role='user')`)
				.run(id, id, id);
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	resetIndex(id: string): void {
		this.get(id);
		this.db.exec("BEGIN IMMEDIATE");
		try {
			this.db.prepare("DELETE FROM messages WHERE sessionId=?").run(id);
			this.db.prepare("UPDATE sessions SET indexedThrough=0 WHERE id=?").run(id);
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	search(query: string, archived = false): SearchResults {
		const sessions = this.list(archived).filter((session) =>
			`${session.title}\n${session.cwd}`.toLowerCase().includes(query.toLowerCase()),
		);
		if (!query.trim()) return { sessions, messages: [] };
		// Treat input as literal terms, never as raw FTS query syntax.
		const match = query
			.trim()
			.split(/\s+/)
			.map((term) => `"${term.replaceAll('"', '""')}"`)
			.join(" AND ");
		const rows = this.db
			.prepare(`SELECT m.*,s.title,s.cwd FROM message_search
			JOIN messages m ON m.rowid=message_search.rowid JOIN sessions s ON s.id=m.sessionId
			WHERE message_search MATCH ? AND (s.archivedAt IS NOT NULL)=?
			ORDER BY rank,m.entryId DESC LIMIT 100`)
			.all(match, Number(archived));
		const messages: SearchHit[] = rows.map((row) => ({
			sessionId: String(row.sessionId),
			conversationId: Number(row.conversationId),
			entryId: Number(row.entryId),
			role: String(row.role) as "user" | "assistant",
			timestamp: Number(row.timestamp),
			text: String(row.text),
			title: String(row.title),
			cwd: String(row.cwd),
		}));
		return { sessions, messages };
	}

	close(): void {
		this.db.close();
	}
}
