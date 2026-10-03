import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { type ModelRef, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { WebSocket, WebSocketServer } from "ws";
import { processLock } from "../shared/process-lock.ts";
import { type ClientAction, errorMessage, type ServerEvent, type SessionSummary } from "../shared/protocol.ts";
import { type ResourceOptions, Resources } from "../shared/resources.ts";
import { Catalog, defaultDataDirectory } from "./catalog.ts";
import { requestOrigin } from "./hosts.ts";
import { cookieName, createMobileServer } from "./http.ts";
import { Logins } from "./login.ts";
import { parseRequest } from "./requests.ts";
import { MAX_UPLOAD_BYTES, UploadError, Uploads } from "./uploads.ts";
import { createWeb } from "./web.ts";
import { type WorkerOptions, Workers } from "./workers.ts";

export type AppOptions = WorkerOptions & {
	directory?: string;
	defaultModel?: ModelRef;
	createModels?: ResourceOptions["createModels"];
	loginTimeoutMs?: number;
	web?: boolean;
	/** Tunnel hosts (HTTPS, authenticated by the tunnel) besides loopback. */
	allowedHosts?: string[];
};

export async function createApp(options: AppOptions = {}) {
	const directory = options.directory ?? defaultDataDirectory;
	const unlock = await processLock(directory, "server");
	let catalog: Catalog;
	try {
		catalog = new Catalog(directory);
	} catch (error) {
		await unlock();
		throw error;
	}
	const workers = new Workers(catalog, options);
	const uploads = new Uploads(directory);
	const token = randomBytes(32).toString("hex");
	const remoteHosts = options.allowedHosts ?? [];
	const nonce = randomBytes(24).toString("hex");
	let web: Awaited<ReturnType<typeof createWeb>> | undefined;
	const http = createMobileServer(
		token,
		options.web
			? {
					nonce,
					handle: (request, response) => {
						if (web) web.handle(request, response);
						else {
							response.writeHead(503);
							response.end("UI is starting");
						}
					},
				}
			: undefined,
		(request, response) => {
			const reply = (status: number, body: unknown) => {
				response.writeHead(status, { "Content-Type": "application/json" });
				response.end(JSON.stringify(body));
			};
			void (async () => {
				const query = new URL(request.url ?? "/", "http://localhost").searchParams;
				const sessionId = query.get("session") ?? "";
				catalog.get(sessionId);
				const name = query.get("name") ?? "";
				if (!name || name.length > 255) throw new UploadError(400, "Invalid file name");
				reply(200, await uploads.save(sessionId, name, request));
			})().catch((error: unknown) => {
				request.resume();
				reply(error instanceof UploadError ? error.status : 400, {
					error: errorMessage(error),
					limit: MAX_UPLOAD_BYTES,
				});
			});
		},
		remoteHosts,
	);
	const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false });
	const clients = new Map<WebSocket, { id: string; pending: number; remote: boolean }>();
	let closing: Promise<void> | undefined;
	const defaultModel = options.defaultModel ?? (options.fake ? { provider: "faux", modelId: "faux-1" } : undefined);
	const resources = new Resources({ directory, fake: options.fake, createModels: options.createModels });
	await resources.start();
	const models = resources.models;

	function send(socket: WebSocket, event: ServerEvent): void {
		if (socket.readyState !== WebSocket.OPEN) return;
		// A slow client reconnects from a fresh snapshot, rather than accumulating
		// an unbounded transcript/token queue in the server.
		if (socket.bufferedAmount > 4 * 1024 * 1024) {
			socket.terminate();
			return;
		}
		socket.send(JSON.stringify(event));
	}
	const logins = new Logins(
		resources,
		(owner, event) => {
			for (const [socket, client] of clients) if (client.id === owner) send(socket, { type: "login", event });
		},
		options.loginTimeoutMs,
	);

	function list(archived?: boolean): SessionSummary[] {
		return catalog.list(archived).map((session) => ({ ...session, worker: workers.status(session.id) }));
	}
	function broadcastCatalog(): void {
		for (const socket of clients.keys()) send(socket, { type: "catalog", sessions: list() });
	}
	const unsubscribe = workers.subscribe((event) => {
		for (const [socket, client] of clients) {
			if (event.type === "view" || event.type === "snapshot") {
				// Only the one conversation this client currently views.
				const viewer = workers.viewer(client.id);
				if (viewer?.sessionId === event.sessionId && viewer.conversationId === event.conversationId)
					send(socket, event);
			} else send(socket, event);
		}
	});

	const stopResources = resources.subscribe(() => {
		for (const socket of clients.keys()) send(socket, { type: "resources", state: resources.snapshot() });
	});

	http.on("upgrade", (request, socket, head) => {
		const target = requestOrigin(request, remoteHosts);
		const cookies = request.headers.cookie?.split(";").map((part) => part.trim()) ?? [];
		const path = (request.url ?? "/").split("?")[0];
		if (
			(path !== "/ws" && !(options.web && path === "/__vite_hmr")) ||
			!target ||
			(request.headers.origin !== undefined && request.headers.origin !== target.origin) ||
			!cookies.includes(`${cookieName(target.port)}=${token}`)
		) {
			socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
			return;
		}
		if (path === "/__vite_hmr") return; // Vite handles this after the same local-cookie/origin gate.
		sockets.handleUpgrade(request, socket, head, (connection) =>
			sockets.emit("connection", connection, target.remote),
		);
	});

	async function action(socket: WebSocket, input: ClientAction): Promise<unknown> {
		const client = clients.get(socket);
		if (closing) throw new Error("Server is shutting down");
		if (!client) throw new Error("Client disconnected");
		switch (input.type) {
			case "login":
				// Provider login stays on localhost (design decision); tunnels only use credentials.
				if (client.remote)
					throw new Error("Provider login is only available on the device itself (http://127.0.0.1)");
				return { attemptId: logins.start(client.id, input.providerId, input.authType) };
			case "loginAnswer":
				logins.answer(client.id, input.attemptId, input.promptId, input.value);
				return;
			case "cancelLogin":
				logins.cancel(client.id, input.attemptId);
				return;
			case "logout":
				await logins.logout(input.providerId);
				return resources.snapshot();
			case "refreshModels":
				await logins.refresh(input.providerId);
				return resources.snapshot();
			case "resources":
				return resources.snapshot();
			case "setSettings":
				await resources.saveSettings(input.settings);
				return resources.snapshot();
			case "list":
				return list(input.archived ?? false);
			case "create": {
				const model = input.model ?? resources.settings.defaultModel ?? defaultModel;
				if (!model) throw new Error("Select a model or configure PI_MOBILE_PROVIDER and PI_MOBILE_MODEL");
				if (!models.getModel(model.provider, model.modelId)) throw new Error("Unknown model");
				const cwd = resolve(
					input.cwd === "~"
						? homedir()
						: input.cwd.startsWith("~/")
							? resolve(homedir(), input.cwd.slice(2))
							: input.cwd,
				);
				if (input.createDirectory) await mkdir(cwd, { recursive: true });
				if (!(await stat(cwd)).isDirectory()) throw new Error("Working directory is not a directory");
				const session = catalog.create(
					cwd,
					model,
					input.thinkingLevel ?? resources.settings.thinkingLevel ?? "off",
					input.title,
				);
				broadcastCatalog();
				await workers.open(session.id);
				return { ...catalog.get(session.id), worker: workers.status(session.id) };
			}
			case "open": {
				const conversationId = input.conversationId ?? ROOT_CONVERSATION_ID;
				if (
					conversationId !== ROOT_CONVERSATION_ID &&
					!catalog.get(input.sessionId).subagents.some((agent) => agent.conversationId === conversationId)
				)
					throw new Error("Unknown conversation");
				const view = await workers.attach(client.id, input.sessionId, conversationId);
				if (!clients.has(socket)) {
					workers.unview(client.id);
					return;
				}
				send(socket, { type: "snapshot", sessionId: input.sessionId, conversationId, view });
				return catalog.get(input.sessionId);
			}
			case "heartbeat":
				if (input.sessionId === null) workers.unview(client.id);
				else workers.heartbeat(client.id, input.sessionId);
				return;
			case "rename":
				catalog.rename(input.sessionId, input.title.trim());
				broadcastCatalog();
				return;
			case "pin":
				catalog.pin(input.sessionId, input.pinned);
				broadcastCatalog();
				return;
			case "archive":
				await workers.archive(input.sessionId);
				broadcastCatalog();
				return;
			case "restore":
				await workers.restore(input.sessionId);
				broadcastCatalog();
				return;
			case "stop":
				await workers.stop(input.sessionId);
				return;
			case "search":
				return catalog.search(input.query, input.archived ?? false);
			case "rebuildIndex":
				await workers.rebuildIndex(input.sessionId);
				broadcastCatalog();
				return;
			case "configure": {
				const session = catalog.get(input.sessionId);
				const model = input.model ?? session.model;
				if (!models.getModel(model.provider, model.modelId)) throw new Error("Unknown model");
				await workers.command(input.sessionId, input);
				catalog.configure(input.sessionId, model, input.thinkingLevel ?? session.thinkingLevel);
				broadcastCatalog();
				return;
			}
			case "prompt": {
				// Only IDs cross the socket; paths come from files this server wrote.
				const attachments = await uploads.resolve(input.sessionId, input.attachments ?? []);
				return { submissionId: await workers.command(input.sessionId, input, attachments) };
			}
			case "abort":
			case "reset":
				return { submissionId: await workers.command(input.sessionId, input) };
		}
	}

	sockets.on("connection", (socket, remote: boolean) => {
		const client = { id: randomUUID(), pending: 0, remote: remote === true };
		clients.set(socket, client);
		send(socket, { type: "catalog", sessions: list() });
		socket.on("error", () => socket.terminate());
		socket.on("close", () => {
			workers.unview(client.id);
			logins.disconnect(client.id);
			clients.delete(socket);
		});
		socket.on("message", (data, binary) => {
			if (client.pending >= 32) {
				socket.close(1008, "Too many pending requests");
				return;
			}
			let id = "";
			client.pending++;
			void (async () => {
				try {
					if (binary) throw new Error("Expected JSON text");
					const raw: unknown = JSON.parse(data.toString());
					if (raw && typeof raw === "object" && "id" in raw && typeof raw.id === "string") id = raw.id;
					const request = parseRequest(raw);
					id = request.id;
					const result = await action(socket, request.action);
					send(socket, { type: "result", id, data: result });
				} catch (error) {
					send(socket, { type: "result", id, error: errorMessage(error) });
				} finally {
					client.pending--;
				}
			})();
		});
	});

	function close(): Promise<void> {
		closing ??= (async () => {
			unsubscribe();
			stopResources();
			await logins.close();
			await web?.close();
			await resources.close();
			for (const socket of clients.keys()) socket.terminate();
			sockets.close();
			const httpClosed = new Promise<void>((done, reject) => {
				if (!http.listening) {
					done();
					return;
				}
				http.close((error) => (error ? reject(error) : done()));
				http.closeAllConnections();
			});
			await workers.close();
			await httpClosed;
			catalog.close();
			await unlock();
		})();
		return closing;
	}
	if (options.web) web = await createWeb(http, nonce, remoteHosts);
	return { http, catalog, workers, resources, logins, web, close };
}
