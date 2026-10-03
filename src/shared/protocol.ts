import type { Op } from "@earendil-works/chord/delta";
import type { AuthType, ModelThinkingLevel, Usage } from "@earendil-works/pi-ai";
import type { ConversationView, ModelRef } from "@earendil-works/pi-durable";
import type { LoginEvent } from "./login-protocol.ts";
import type { ResourceError, ResourceSnapshot } from "./resources.ts";
import type { MobileSettings } from "./settings.ts";
import type { Access, Author, ShareSettings } from "./sharing.ts";

export type Attachment = { id: string; name: string; path: string; size: number; mimeType?: string };
export type Restored = { author: Author; text: string };
export type SubagentInfo = {
	name: string;
	conversationId: number;
	model: string;
	thinkingLevel: string;
	tools: string[];
};
export type SessionInfo = {
	id: string;
	cwd: string;
	title: string;
	createdAt: number;
	updatedAt: number;
	archivedAt: number | null;
	pinned: boolean;
	model: ModelRef;
	thinkingLevel: ModelThinkingLevel;
	indexedThrough: number;
	subagents: SubagentInfo[];
};
export type WorkerStatus = {
	running: boolean;
	pid?: number;
	tasks: number;
	/** Conversation IDs with live tasks. */
	busy?: number[];
	error?: string;
	resourceErrors?: ResourceError[];
	/** Whole-session spend while the worker runs: every conversation, subagents and tools. */
	usage?: Usage;
};
export type SessionSummary = SessionInfo & { worker: WorkerStatus };
export type IndexedMessage = {
	conversationId: number;
	entryId: number;
	role: "user" | "assistant";
	timestamp: number;
	text: string;
};
export type SearchHit = IndexedMessage & { sessionId: string; title: string; cwd: string };
export type SearchResults = { sessions: SessionInfo[]; messages: SearchHit[] };
export type CreateSession = {
	cwd: string;
	createDirectory?: boolean;
	title?: string;
	model?: ModelRef;
	thinkingLevel?: ModelThinkingLevel;
};
export type WorkerAction =
	| {
			type: "prompt";
			content: string;
			conversationId?: number;
			requestId: string;
			whenBusy?: "steer" | "followUp" | "reject";
			/** Upload IDs from POST /upload; the server resolves them to files. */
			attachments?: string[];
	  }
	| { type: "abort"; background?: boolean; conversationId?: number }
	/** Withdraw one queued steer/follow-up before it is placed. */
	| { type: "dequeue"; submissionId: number; conversationId?: number; restore?: boolean }
	| { type: "configure"; model?: ModelRef; thinkingLevel?: ModelThinkingLevel }
	| { type: "reset" };
export type WorkerCommand =
	| { type: "init"; session: SessionInfo; storagePath: string; fake: boolean; resume: boolean }
	| { type: "command"; id: string; action: WorkerAction; attachments?: Attachment[]; author?: Author }
	| { type: "watch"; id: string; conversationId: number }
	| { type: "unwatch"; conversationId: number }
	| { type: "indexed"; id: string; error?: string };
export type WorkerEvent =
	| { type: "ready"; tasks: number; busy: number[] }
	| { type: "view"; conversationId: number; ops: readonly Op[] }
	| { type: "tasks"; count: number; busy: number[] }
	| { type: "subagents"; subagents: SubagentInfo[] }
	| { type: "resources"; errors: ResourceError[] }
	| { type: "usage"; usage: Usage }
	| { type: "index"; id: string; messages: IndexedMessage[]; through: number }
	| {
			type: "result";
			id: string;
			submissionId?: number;
			/** Abort: queued inputs withdrawn before stopping, returned to each author's composer. */
			restored?: Restored[];
			view?: ConversationView;
			error?: string;
	  }
	| { type: "fatal"; error: string };

export type ClientAction =
	| { type: "shareGet" | "shareRevoke"; sessionId: string }
	| { type: "shareSet"; sessionId: string; settings: ShareSettings; reset?: boolean }
	| { type: "shareGuest"; sessionId: string; guestId: string; muted: boolean; removed: boolean }
	| { type: "login"; providerId: string; authType: AuthType }
	| { type: "loginAnswer"; attemptId: string; promptId: string; value: string }
	| { type: "cancelLogin"; attemptId: string }
	| { type: "logout" | "refreshModels"; providerId: string }
	| { type: "resources" }
	| { type: "setSettings"; settings: MobileSettings }
	| { type: "list"; archived?: boolean }
	| ({ type: "create" } & CreateSession)
	| { type: "open"; sessionId: string; conversationId?: number }
	| { type: "heartbeat"; sessionId: string | null }
	| { type: "rename"; sessionId: string; title: string }
	| { type: "pin"; sessionId: string; pinned: boolean }
	| { type: "archive" | "restore" | "stop"; sessionId: string }
	| { type: "search"; query: string; archived?: boolean }
	| { type: "rebuildIndex"; sessionId: string }
	| ({ sessionId: string } & WorkerAction);
export type ClientRequest = { id: string; action: ClientAction };
export type ServerEvent =
	| { type: "access"; access: Access }
	| { type: "login"; event: LoginEvent }
	| { type: "result"; id: string; data?: unknown; error?: string }
	| { type: "catalog"; sessions: SessionSummary[] }
	| { type: "resources"; state: ResourceSnapshot }
	| { type: "snapshot"; sessionId: string; conversationId: number; view: ConversationView }
	| { type: "view"; sessionId: string; conversationId: number; ops: readonly Op[] }
	| { type: "worker"; sessionId: string; status: WorkerStatus }
	/** Sent only to the author's own connections: Stop withdrew their queued input. */
	| { type: "restore"; sessionId: string; conversationId: number; texts: string[] };

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
