import { type ChildProcess, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { applyImmutable } from "@earendil-works/chord/delta";
import type { Usage } from "@earendil-works/pi-ai";
import type { ConversationView } from "@earendil-works/pi-durable";
import {
	type Attachment,
	errorMessage,
	type Restored,
	type ServerEvent,
	type WorkerAction,
	type WorkerCommand,
	type WorkerEvent,
	type WorkerStatus,
} from "../shared/protocol.ts";
import type { ResourceError } from "../shared/resources.ts";
import type { Author } from "../shared/sharing.ts";
import type { Catalog } from "./catalog.ts";

type WorkerResult = { submissionId?: number; restored?: Restored[]; view?: ConversationView };
type RunningWorker = {
	child: ChildProcess;
	ready: Promise<void>;
	exited: Promise<void>;
	/** Conversation views the worker currently watches: only those some client views. */
	views: Map<number, ConversationView>;
	watching: Map<number, Promise<ConversationView>>;
	tasks: number;
	busy: number[];
	resourceErrors: ResourceError[];
	usage?: Usage;
	booting: boolean;
	stopping: boolean;
	pending: Map<
		string,
		{ resolve: (result: WorkerResult) => void; reject: (error: Error) => void; viewConversationId?: number }
	>;
	idleTimer?: ReturnType<typeof setTimeout>;
};
export type WorkerOptions = { fake?: boolean; idleMs?: number; heartbeatMs?: number; recover?: boolean };
type Viewer = { sessionId: string; conversationId: number; expires: number };

export class Workers {
	private readonly catalog: Catalog;
	private readonly options: Required<WorkerOptions>;
	private readonly running = new Map<string, RunningWorker>();
	private readonly errors = new Map<string, string>();
	private readonly locks = new Map<string, Promise<unknown>>();
	private readonly viewers = new Map<string, Viewer>();
	private readonly listeners = new Set<(event: ServerEvent) => void>();
	private readonly sweep: ReturnType<typeof setInterval>;
	private closing = false;
	private readonly restarts = new Map<string, number>();
	private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

	constructor(catalog: Catalog, options: WorkerOptions = {}) {
		this.catalog = catalog;
		this.options = {
			fake: options.fake ?? false,
			idleMs: options.idleMs ?? 300_000,
			heartbeatMs: options.heartbeatMs ?? 45_000,
			recover: options.recover ?? false,
		};
		this.sweep = setInterval(
			() => {
				for (const [clientId, viewer] of this.viewers) {
					if (viewer.expires <= Date.now()) this.unview(clientId);
				}
			},
			Math.min(1000, this.options.heartbeatMs),
		);
		this.sweep.unref();
	}

	subscribe(listener: (event: ServerEvent) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	private emit(event: ServerEvent): void {
		for (const listener of this.listeners) listener(event);
	}

	status(id: string): WorkerStatus {
		const worker = this.running.get(id);
		return {
			running: worker !== undefined,
			...(worker?.child.pid === undefined ? {} : { pid: worker.child.pid }),
			tasks: worker?.tasks ?? 0,
			...(worker?.busy.length ? { busy: worker.busy } : {}),
			...(worker ? { resourceErrors: worker.resourceErrors } : {}),
			...(worker?.usage ? { usage: worker.usage } : {}),
			...(this.errors.has(id) ? { error: this.errors.get(id) } : {}),
		};
	}

	private changed(id: string): void {
		this.emit({ type: "worker", sessionId: id, status: this.status(id) });
	}

	// Serialize ownership-changing operations per session. Await process exit,
	// not just kill() or an IPC disconnect, before another owner opens storage.
	private serial<T>(id: string, operation: () => Promise<T>): Promise<T> {
		if (this.closing) return Promise.reject(new Error("Server is shutting down"));
		const result = (this.locks.get(id) ?? Promise.resolve())
			.catch(() => {})
			.then(() => {
				if (this.closing) throw new Error("Server is shutting down");
				return operation();
			});
		this.locks.set(id, result);
		void result
			.finally(() => {
				if (this.locks.get(id) === result) this.locks.delete(id);
			})
			.catch(() => {});
		return result;
	}

	private send(worker: RunningWorker, message: WorkerCommand): void {
		if (!worker.child.connected) throw new Error("Worker disconnected");
		worker.child.send(message, (error) => {
			if (error && !worker.stopping) worker.child.kill("SIGTERM");
		});
	}

	private async start(id: string, allowArchived = false): Promise<RunningWorker> {
		const session = this.catalog.get(id);
		if (session.archivedAt !== null && !allowArchived) throw new Error("Session is archived");
		let worker = this.running.get(id);
		if (worker?.stopping) {
			await worker.exited;
			worker = undefined;
		}
		if (worker) {
			await worker.ready;
			return worker;
		}
		clearTimeout(this.retryTimers.get(id));
		this.retryTimers.delete(id);
		if (this.options.recover && !allowArchived) this.catalog.setResume(id, true);
		const child = fork(
			new URL(import.meta.url.endsWith(".ts") ? "../worker/main.ts" : "../worker/main.js", import.meta.url),
			[],
			{
				stdio: ["ignore", "ignore", "pipe", "ipc"],
				execArgv: [],
			},
		);
		// Keep only a short tail for startup diagnostics, never environment dumps.
		let stderr = "";
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr = (stderr + chunk.toString()).slice(-4000);
		});
		const ready = Promise.withResolvers<void>();
		const exited = Promise.withResolvers<void>();
		worker = {
			child,
			ready: ready.promise,
			exited: exited.promise,
			views: new Map(),
			watching: new Map(),
			tasks: 0,
			busy: [],
			resourceErrors: [],
			booting: true,
			stopping: false,
			pending: new Map(),
		};
		const current = worker;
		this.running.set(id, current);
		this.errors.delete(id);
		const timeout = setTimeout(() => {
			this.errors.set(id, "Worker startup timed out");
			ready.reject(new Error("Worker startup timed out"));
			child.kill("SIGKILL");
		}, 60_000);
		const fail = (error: string) => {
			this.errors.set(id, error);
			ready.reject(new Error(error));
			for (const pending of current.pending.values()) pending.reject(new Error(error));
			current.pending.clear();
		};
		child.on("message", (event: WorkerEvent) => {
			try {
				switch (event.type) {
					case "ready":
						clearTimeout(timeout);
						current.tasks = event.tasks;
						current.busy = event.busy;
						current.booting = false;
						ready.resolve();
						this.reconcile(id);
						this.changed(id);
						break;
					case "view": {
						// Frames of a watch released meanwhile are dropped; a new watch starts from a snapshot.
						const view = current.views.get(event.conversationId);
						if (!view) break;
						current.views.set(event.conversationId, applyImmutable(view, event.ops));
						this.emit({ type: "view", sessionId: id, conversationId: event.conversationId, ops: event.ops });
						break;
					}
					case "tasks":
						current.tasks = event.count;
						current.busy = event.busy;
						this.reconcile(id);
						this.changed(id);
						break;
					case "subagents":
						this.catalog.setSubagents(id, event.subagents);
						this.emitCatalog();
						break;
					case "resources":
						current.resourceErrors = event.errors;
						this.changed(id);
						break;
					case "usage":
						current.usage = event.usage;
						this.changed(id);
						break;
					case "index":
						try {
							this.catalog.index(id, event.messages, event.through);
							this.send(current, { type: "indexed", id: event.id });
							this.emitCatalog();
						} catch (error) {
							this.send(current, { type: "indexed", id: event.id, error: errorMessage(error) });
						}
						break;
					case "result": {
						const pending = current.pending.get(event.id);
						current.pending.delete(event.id);
						// IPC can dispatch the next frame before a resolved Promise's continuation.
						// Install the base synchronously so that frame cannot be dropped.
						if (pending?.viewConversationId !== undefined && event.view) {
							current.views.set(pending.viewConversationId, event.view);
							this.emit({
								type: "snapshot",
								sessionId: id,
								conversationId: pending.viewConversationId,
								view: event.view,
							});
						}
						if (event.error) pending?.reject(new Error(event.error));
						else
							pending?.resolve({ submissionId: event.submissionId, restored: event.restored, view: event.view });
						this.reconcile(id);
						break;
					}
					case "fatal":
						fail(event.error);
						child.kill("SIGTERM");
						break;
				}
			} catch (error) {
				fail(errorMessage(error));
				child.kill("SIGTERM");
			}
		});
		child.once("error", (error) => {
			fail(error.message);
		});
		child.once("close", (code, signal) => {
			clearTimeout(timeout);
			clearTimeout(current.idleTimer);
			if (!current.stopping && !this.errors.has(id)) {
				this.errors.set(id, `Worker exited (${signal ?? code})${stderr ? `: ${stderr.trim()}` : ""}`);
			}
			fail(this.errors.get(id) ?? "Worker stopped");
			if (current.stopping) this.errors.delete(id);
			this.running.delete(id);
			exited.resolve();
			this.changed(id);
			if (this.options.recover && !current.stopping && !this.closing && this.catalog.resumable().includes(id)) {
				const attempt = (this.restarts.get(id) ?? 0) + 1;
				this.restarts.set(id, attempt);
				this.retryTimers.set(
					id,
					setTimeout(
						() => {
							this.retryTimers.delete(id);
							void this.open(id).catch(() => {});
						},
						Math.min(500 * 2 ** (attempt - 1), 10_000),
					),
				);
			}
		});
		// Observe boot rejection even if shutdown kills a worker before a caller awaits it.
		void current.ready.catch(() => {});
		this.send(current, {
			type: "init",
			session,
			storagePath: this.catalog.storagePath(id),
			fake: this.options.fake,
			resume: session.archivedAt === null,
		});
		this.changed(id);
		try {
			await current.ready;
			// A restarted worker has no watches: give current viewers fresh snapshots.
			const viewed = new Set(
				[...this.viewers.values()]
					.filter((viewer) => viewer.sessionId === id)
					.map((viewer) => viewer.conversationId),
			);
			for (const conversationId of viewed) await this.watch(id, current, conversationId).catch(() => undefined);
			return current;
		} catch (error) {
			await this.terminate(id);
			this.errors.set(id, errorMessage(error));
			this.changed(id);
			throw error;
		}
	}

	private emitCatalog(): void {
		this.emit({
			type: "catalog",
			sessions: this.catalog.list().map((session) => ({ ...session, worker: this.status(session.id) })),
		});
	}

	private call(id: string, worker: RunningWorker, message: (commandId: string) => WorkerCommand) {
		const commandId = randomUUID();
		const command = message(commandId);
		const result = new Promise<WorkerResult>((resolve, reject) =>
			worker.pending.set(commandId, {
				resolve,
				reject,
				...(command.type === "watch" ? { viewConversationId: command.conversationId } : {}),
			}),
		);
		this.reconcile(id);
		try {
			this.send(worker, command);
		} catch (error) {
			worker.pending.delete(commandId);
			this.reconcile(id);
			throw error;
		}
		return result;
	}

	// One worker watch per viewed conversation, shared by its viewers.
	private watch(id: string, worker: RunningWorker, conversationId: number): Promise<ConversationView> {
		const cached = worker.views.get(conversationId);
		if (cached) return Promise.resolve(cached);
		const existing = worker.watching.get(conversationId);
		if (existing) return existing;
		const pending = this.call(id, worker, (commandId) => ({ type: "watch", id: commandId, conversationId }))
			.then((result) => {
				if (!result.view) throw new Error("Worker returned no view");
				return worker.views.get(conversationId) ?? result.view;
			})
			.finally(() => {
				if (worker.watching.get(conversationId) === pending) worker.watching.delete(conversationId);
			});
		worker.watching.set(conversationId, pending);
		return pending;
	}

	// Stop the worker's watch once no viewer remains, so hidden conversations cost nothing.
	private release(sessionId: string, conversationId: number): void {
		const worker = this.running.get(sessionId);
		if (!worker) return;
		const viewed = [...this.viewers.values()].some(
			(viewer) => viewer.sessionId === sessionId && viewer.conversationId === conversationId,
		);
		if (viewed) return;
		const pending = worker.watching.get(conversationId);
		if (pending) {
			void pending.then(
				() => this.release(sessionId, conversationId),
				() => {},
			);
			return;
		}
		if (!worker.views.delete(conversationId) || !worker.child.connected) return;
		this.send(worker, { type: "unwatch", conversationId });
	}

	open(id: string): Promise<void> {
		return this.serial(id, async () => {
			await this.start(id);
		});
	}

	async recover(): Promise<void> {
		if (!this.options.recover) return;
		for (const id of this.catalog.resumable()) {
			try {
				await this.open(id);
			} catch (error) {
				this.errors.set(id, errorMessage(error));
				this.changed(id);
			}
		}
	}

	/** Make `clientId` view one conversation of a session and return its current view. */
	attach(clientId: string, sessionId: string, conversationId: number): Promise<ConversationView> {
		return this.serial(sessionId, async () => {
			const worker = await this.start(sessionId);
			const previous = this.viewers.get(clientId);
			this.viewers.set(clientId, { sessionId, conversationId, expires: Date.now() + this.options.heartbeatMs });
			if (previous && (previous.sessionId !== sessionId || previous.conversationId !== conversationId)) {
				this.release(previous.sessionId, previous.conversationId);
				this.reconcile(previous.sessionId);
			}
			this.reconcile(sessionId);
			try {
				return await this.watch(sessionId, worker, conversationId);
			} catch (error) {
				this.unview(clientId);
				throw error;
			}
		});
	}

	viewer(clientId: string): Viewer | undefined {
		return this.viewers.get(clientId);
	}

	/** Extend a lease; fails after expiry so the client reattaches from a fresh snapshot. */
	heartbeat(clientId: string, sessionId: string): void {
		const viewer = this.viewers.get(clientId);
		if (!viewer || viewer.sessionId !== sessionId) throw new Error("Open the viewed session first");
		viewer.expires = Date.now() + this.options.heartbeatMs;
		this.reconcile(sessionId);
	}

	async command(
		id: string,
		action: WorkerAction,
		attachments?: Attachment[],
		author?: Author,
	): Promise<{ submissionId?: number; restored?: Restored[] }> {
		const result = await this.serial(id, async () => {
			const worker = await this.start(id);
			return {
				result: this.call(id, worker, (commandId) => ({
					type: "command",
					id: commandId,
					action,
					...(author ? { author } : {}),
					...(attachments?.length ? { attachments } : {}),
				})),
			};
		});
		// Do not hold the lifecycle lock while an abort waits on tool code.
		// Archive/shutdown must still be able to kill that process.
		const { submissionId, restored } = await result.result;
		return { submissionId, restored };
	}

	unview(clientId: string): void {
		const viewer = this.viewers.get(clientId);
		this.viewers.delete(clientId);
		if (!viewer) return;
		this.release(viewer.sessionId, viewer.conversationId);
		this.reconcile(viewer.sessionId);
	}

	private reconcile(id: string): void {
		const worker = this.running.get(id);
		if (!worker) return;
		const viewed = [...this.viewers.values()].some(
			(viewer) => viewer.sessionId === id && viewer.expires > Date.now(),
		);
		if (worker.booting || worker.stopping || worker.tasks > 0 || worker.pending.size > 0 || viewed) {
			clearTimeout(worker.idleTimer);
			worker.idleTimer = undefined;
		} else if (!worker.idleTimer) {
			worker.idleTimer = setTimeout(() => {
				worker.idleTimer = undefined;
				void this.serial(id, async () => {
					const viewedNow = [...this.viewers.values()].some(
						(viewer) => viewer.sessionId === id && viewer.expires > Date.now(),
					);
					if (this.running.get(id) === worker && !viewedNow && worker.tasks === 0 && worker.pending.size === 0) {
						this.catalog.setResume(id, false);
						await this.terminate(id);
					}
				}).catch(() => {});
			}, this.options.idleMs);
			worker.idleTimer.unref();
		}
	}

	private async terminate(id: string): Promise<void> {
		const worker = this.running.get(id);
		if (!worker) return;
		worker.stopping = true;
		clearTimeout(worker.idleTimer);
		worker.child.kill("SIGTERM");
		const force = setTimeout(() => worker.child.kill("SIGKILL"), 2000);
		try {
			await worker.exited;
		} finally {
			clearTimeout(force);
		}
	}

	stop(id: string): Promise<void> {
		return this.serial(id, async () => {
			this.catalog.get(id);
			this.catalog.setResume(id, false);
			clearTimeout(this.retryTimers.get(id));
			this.retryTimers.delete(id);
			await this.terminate(id);
		});
	}

	archive(id: string): Promise<void> {
		return this.serial(id, async () => {
			this.catalog.archive(id, true);
			this.catalog.setResume(id, false);
			clearTimeout(this.retryTimers.get(id));
			this.retryTimers.delete(id);
			await this.terminate(id);
		});
	}

	restore(id: string): Promise<void> {
		return this.serial(id, async () => {
			this.catalog.archive(id, false);
		});
	}

	rebuildIndex(id: string): Promise<void> {
		return this.serial(id, async () => {
			await this.terminate(id);
			this.catalog.resetIndex(id);
			const archived = this.catalog.get(id).archivedAt !== null;
			await this.start(id, true);
			// Archived sessions are scanned without resuming work and stopped again.
			if (archived) await this.terminate(id);
		});
	}

	async close(): Promise<void> {
		this.closing = true;
		for (const timer of this.retryTimers.values()) clearTimeout(timer);
		this.retryTimers.clear();
		clearInterval(this.sweep);
		await Promise.all([...this.running.keys()].map((id) => this.terminate(id)));
		await Promise.allSettled([...this.locks.values()]);
	}
}
