import { applyImmutable } from "@earendil-works/chord/delta";
import type { ConversationView } from "@earendil-works/pi-durable";
import type { LoginEvent, LoginPrompt } from "../shared/login-protocol.ts";
import type { ClientAction, ServerEvent, SessionSummary } from "../shared/protocol.ts";
import type { ResourceSnapshot } from "../shared/resources.ts";
import type { Access } from "../shared/sharing.ts";

export type LoginView = {
	attemptId: string;
	providerId: string;
	status: "working" | "success" | "cancelled" | "error";
	prompt?: LoginPrompt;
	notices: { id: string; event: Extract<LoginEvent, { type: "notice" }>["event"] }[];
	message?: string;
};
export type MobileState = {
	connected: boolean;
	access?: Access;
	sessions: SessionSummary[];
	resources?: ResourceSnapshot;
	activeId?: string;
	/** Viewed conversation: 1 is the session's main conversation, others are subagents. */
	conversationId: number;
	view?: ConversationView;
	login?: LoginView;
	error?: string;
};

export class MobileClient {
	private state: MobileState = { connected: false, sessions: [], conversationId: 1 };
	private readonly listeners = new Set<() => void>();
	private readonly restoreListeners = new Set<(texts: string[]) => void>();
	private readonly pending = new Map<
		string,
		{ resolve: (data: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
	>();
	private socket?: WebSocket;
	private retry?: ReturnType<typeof setTimeout>;
	private heartbeat?: ReturnType<typeof setInterval>;
	private stopped = true;
	private generation = 0;
	readonly snapshot = () => this.state;
	readonly subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};

	/** Queued input of this user withdrawn by someone's Stop, to put back into the composer. */
	readonly onRestore = (listener: (texts: string[]) => void) => {
		this.restoreListeners.add(listener);
		return () => {
			this.restoreListeners.delete(listener);
		};
	};

	private update(patch: Partial<MobileState>): void {
		this.state = { ...this.state, ...patch };
		for (const listener of this.listeners) listener();
	}
	setError(error?: string): void {
		this.update({ error });
	}
	dismissLogin(): void {
		this.update({ login: undefined });
	}

	start(): void {
		if (!this.stopped) return;
		this.stopped = false;
		this.heartbeat = setInterval(() => {
			const { connected, activeId, conversationId } = this.state;
			if (connected && activeId)
				void this.request({ type: "heartbeat", sessionId: activeId }).catch(() => {
					if (
						this.state.connected &&
						this.state.activeId === activeId &&
						this.state.conversationId === conversationId
					)
						void this.open(activeId, conversationId, false).catch((error: Error) => this.setError(error.message));
				});
		}, 15_000);
		window.addEventListener("popstate", this.navigate);
		document.addEventListener("visibilitychange", this.visible);
		void this.connect();
	}
	private readonly visible = () => {
		if (document.visibilityState === "visible" && this.state.connected && this.state.activeId)
			void this.open(this.state.activeId, this.state.conversationId, false).catch((error: Error) =>
				this.setError(error.message),
			);
	};
	private readonly navigate = () => {
		const match = /^\/s\/([^/]+)(?:\/a\/(\d+))?$/.exec(location.pathname);
		if (match?.[1])
			void this.open(match[1], Number(match[2] ?? 1), false).catch((error: Error) => this.setError(error.message));
		else if (this.state.access?.kind !== "guest") this.leave(false);
	};

	private async connect(): Promise<void> {
		const generation = ++this.generation;
		try {
			// Refresh the HttpOnly cookie after a backend restart. Never replay input.
			const response = await fetch("/", { cache: "no-store", credentials: "same-origin" });
			if (!response.ok) throw new Error("Could not connect to the local server");
			if (this.stopped || generation !== this.generation) return;
			const socket = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`);
			this.socket = socket;
			socket.onmessage = (message) => {
				if (this.socket !== socket) return;
				try {
					this.receive(JSON.parse(String(message.data)) as ServerEvent);
				} catch {
					this.update({ error: "State update failed. Reconnecting for a fresh snapshot." });
					socket.close();
				}
			};
			socket.onopen = () => {
				if (this.socket !== socket) return;
				this.update({ connected: true });
				// The server sends access before catalog. Initialize after that event,
				// never request owner resources on a guest connection.
			};
			socket.onerror = () => socket.close();
			socket.onclose = (event) => {
				if (this.socket !== socket) return;
				this.update({ connected: false, login: undefined });
				for (const pending of this.pending.values()) {
					clearTimeout(pending.timer);
					pending.reject(new Error("Connection lost. Check the transcript before retrying input."));
				}
				this.pending.clear();
				if (event.code === 1008 && this.state.access?.kind === "guest") {
					this.update({ view: undefined, sessions: [], error: "This share has ended." });
					return;
				}
				this.scheduleReconnect();
			};
		} catch {
			this.update({ connected: false });
			this.scheduleReconnect();
		}
	}

	private scheduleReconnect(): void {
		if (this.stopped) return;
		clearTimeout(this.retry);
		this.retry = setTimeout(() => {
			void this.connect();
		}, 1500);
	}

	private receive(event: ServerEvent): void {
		switch (event.type) {
			case "access": {
				const initial = this.state.access === undefined || !this.state.view;
				this.update({ access: event.access, ...(event.access.kind === "guest" ? { resources: undefined } : {}) });
				if (event.access.kind === "owner")
					void this.request<ResourceSnapshot>({ type: "resources" })
						.then((resources) => this.update({ resources }))
						.catch((error: Error) => this.setError(error.message));
				if (initial || this.state.activeId) {
					const route = /^\/s\/([^/]+)(?:\/a\/(\d+))?$/.exec(location.pathname);
					let id = this.state.activeId;
					let conversation = this.state.conversationId;
					if (route?.[1]) {
						id = route[1];
						conversation = Number(route[2] ?? 1);
					}
					if (event.access.kind === "guest") {
						if (id !== event.access.sessionId) conversation = 1;
						id = event.access.sessionId;
					} else if (!id) {
						try {
							id = localStorage.getItem("pi-mobile-session") ?? undefined;
						} catch {}
					}
					if (id) void this.open(id, conversation, false).catch((error: Error) => this.setError(error.message));
				}
				break;
			}
			case "result": {
				const pending = this.pending.get(event.id);
				this.pending.delete(event.id);
				clearTimeout(pending?.timer);
				if (event.error) pending?.reject(new Error(event.error));
				else pending?.resolve(event.data);
				break;
			}
			case "catalog":
				this.update({ sessions: event.sessions });
				break;
			case "resources":
				this.update({ resources: event.state });
				break;
			case "worker":
				this.update({
					sessions: this.state.sessions.map((session) =>
						session.id === event.sessionId ? { ...session, worker: event.status } : session,
					),
				});
				break;
			case "snapshot":
				this.update({ activeId: event.sessionId, conversationId: event.conversationId, view: event.view });
				break;
			case "view":
				if (this.state.activeId === event.sessionId && this.state.conversationId === event.conversationId) {
					if (!this.state.view) throw new Error("Missing snapshot");
					this.update({ view: applyImmutable(this.state.view, event.ops) });
				}
				break;
			case "login":
				this.loginEvent(event.event);
				break;
			case "restore":
				for (const listener of this.restoreListeners) listener(event.texts);
				break;
		}
	}

	private loginEvent(event: LoginEvent): void {
		if (event.type === "started") {
			this.update({
				login: { attemptId: event.attemptId, providerId: event.providerId, status: "working", notices: [] },
			});
			return;
		}
		const login = this.state.login;
		if (!login || login.attemptId !== event.attemptId) return;
		if (event.type === "prompt") this.update({ login: { ...login, prompt: event.prompt } });
		else if (event.type === "promptClosed" && login.prompt?.id === event.promptId)
			this.update({ login: { ...login, prompt: undefined } });
		else if (event.type === "notice")
			this.update({
				login: {
					...login,
					notices: [...login.notices.slice(-19), { id: crypto.randomUUID(), event: event.event }],
				},
			});
		else if (event.type === "finished")
			this.update({ login: { ...login, status: event.status, prompt: undefined, message: event.message } });
	}

	async request<T = unknown>(action: ClientAction): Promise<T> {
		const socket = this.socket;
		if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("Server is disconnected");
		const id = crypto.randomUUID();
		const result = new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error("Request timed out. Check the current state before retrying."));
			}, 30_000);
			this.pending.set(id, { resolve, reject, timer });
		});
		socket.send(JSON.stringify({ id, action }));
		return (await result) as T;
	}

	// The server keeps exactly one watched conversation per connection; opening
	// another releases the previous one.
	async open(sessionId: string, conversationId = 1, navigate = true): Promise<void> {
		if (sessionId !== this.state.activeId || conversationId !== this.state.conversationId)
			this.update({ view: undefined, activeId: sessionId, conversationId });
		await this.request({ type: "open", sessionId, conversationId });
		const path = `/s/${sessionId}${conversationId === 1 ? "" : `/a/${conversationId}`}`;
		if (navigate && location.pathname !== path) history.pushState(null, "", path);
		try {
			localStorage.setItem("pi-mobile-session", sessionId);
		} catch {}
	}

	// Leave the current session for the new-session screen; the worker keeps running.
	leave(navigate = true): void {
		if (this.state.activeId && this.state.connected)
			void this.request({ type: "heartbeat", sessionId: null }).catch(() => {});
		try {
			localStorage.removeItem("pi-mobile-session");
		} catch {}
		if (navigate && location.pathname !== "/") history.pushState(null, "", "/");
		this.update({ activeId: undefined, conversationId: 1, view: undefined });
	}

	stop(): void {
		this.stopped = true;
		window.removeEventListener("popstate", this.navigate);
		document.removeEventListener("visibilitychange", this.visible);
		this.generation++;
		clearTimeout(this.retry);
		clearInterval(this.heartbeat);
		this.socket?.close();
	}
}
