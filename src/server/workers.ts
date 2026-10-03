import { type ChildProcess, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { applyImmutable } from "@earendil-works/chord/delta";
import type { ConversationView } from "@earendil-works/pi-durable";
import {
	type Attachment,
	errorMessage,
	type ServerEvent,
	type WorkerAction,
	type WorkerCommand,
	type WorkerEvent,
	type WorkerStatus,
} from "../shared/protocol.ts";
import type { ResourceError } from "../shared/resources.ts";
import type { Author } from "../shared/sharing.ts";
import type { Catalog } from "./catalog.ts";

type WorkerResult = { submissionId?: number; view?: ConversationView };
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
	booting: boolean;
	stopping: boolean;
	pending: Map<string, { resolve: (result: WorkerResult) => void; reject: (error: Error) => void }>;
	idleTimer?: ReturnType<typeof setTimeout>;
};
export type WorkerOptions = { fake?: boolean; idleMs?: number; heartbeatMs?: number };
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

	constructor(catalog: Catalog, options: WorkerOptions = {}) {
		this.catalog = catalog;
		this.options = {
			fake: options.fake ?? false,
			idleMs: options.idleMs ?? 300_000,
			heartbeatMs: options.heartbeatMs ?? 45_000,
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
						if (event.error) pending?.reject(new Error(event.error));
						else pending?.resolve({ submissionId: event.submissionId, view: event.view });
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
			for (const conversationId of viewed) {
				const view = await this.watch(id, current, conversationId).catch(() => undefined);
				if (view) this.emit({ type: "snapshot", sessionId: id, conversationId, view });
			}
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
		const result = new Promise<WorkerResult>((resolve, reject) => worker.pending.set(commandId, { resolve, reject }));
		this.reconcile(id);
		try {
			this.send(worker, message(commandId));
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
				worker.views.set(conversationId, result.view);
				return result.view;
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
	): Promise<number | undefined> {
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
		return (await result.result).submissionId;
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
			await this.terminate(id);
		});
	}

	archive(id: string): Promise<void> {
		return this.serial(id, async () => {
			this.catalog.archive(id, true);
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
		clearInterval(this.sweep);
		await Promise.all([...this.running.keys()].map((id) => this.terminate(id)));
		await Promise.allSettled([...this.locks.values()]);
	}
}
