import type { ClientRequest } from "../shared/protocol.ts";
import { validateSettings } from "../shared/settings.ts";

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object");
	return value as Record<string, unknown>;
}

function string(value: unknown, field: string): void {
	if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid ${field}`);
}

function boolean(value: unknown, field: string, optional = false): void {
	if (optional && value === undefined) return;
	if (typeof value !== "boolean") throw new Error(`Invalid ${field}`);
}

export function parseRequest(value: unknown): ClientRequest {
	const request = object(value);
	string(request.id, "id");
	const action = object(request.action);
	if (
		![
			"login",
			"loginAnswer",
			"cancelLogin",
			"logout",
			"refreshModels",
			"resources",
			"setSettings",
			"list",
			"create",
			"open",
			"heartbeat",
			"rename",
			"pin",
			"archive",
			"restore",
			"stop",
			"search",
			"rebuildIndex",
			"prompt",
			"abort",
			"reset",
			"configure",
		].includes(String(action.type))
	) {
		throw new Error("Unknown action");
	}
	if (
		![
			"list",
			"create",
			"search",
			"resources",
			"setSettings",
			"login",
			"loginAnswer",
			"cancelLogin",
			"logout",
			"refreshModels",
		].includes(String(action.type)) &&
		!(action.type === "heartbeat" && action.sessionId === null)
	) {
		string(action.sessionId, "sessionId");
	}
	switch (action.type) {
		case "login":
			string(action.providerId, "providerId");
			if (action.authType !== "api_key" && action.authType !== "oauth") throw new Error("Invalid authType");
			break;
		case "loginAnswer":
			string(action.attemptId, "attemptId");
			string(action.promptId, "promptId");
			if (typeof action.value !== "string") throw new Error("Invalid login answer");
			break;
		case "cancelLogin":
			string(action.attemptId, "attemptId");
			break;
		case "logout":
		case "refreshModels":
			string(action.providerId, "providerId");
			break;
		case "setSettings":
			validateSettings(action.settings);
			break;
		case "list":
			boolean(action.archived, "archived", true);
			break;
		case "create":
			string(action.cwd, "cwd");
			boolean(action.createDirectory, "createDirectory", true);
			if (action.title !== undefined) string(action.title, "title");
			if (action.model !== undefined) {
				const model = object(action.model);
				string(model.provider, "provider");
				string(model.modelId, "modelId");
			}
			if (
				action.thinkingLevel !== undefined &&
				!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(action.thinkingLevel))
			) {
				throw new Error("Invalid thinkingLevel");
			}
			break;
		case "configure":
			if (action.model !== undefined) {
				const model = object(action.model);
				string(model.provider, "provider");
				string(model.modelId, "modelId");
			}
			if (
				action.thinkingLevel !== undefined &&
				!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(action.thinkingLevel))
			) {
				throw new Error("Invalid thinkingLevel");
			}
			break;
		case "open":
			if (action.conversationId !== undefined && !Number.isSafeInteger(action.conversationId))
				throw new Error("Invalid conversationId");
			break;
		case "abort":
			if (action.conversationId !== undefined && !Number.isSafeInteger(action.conversationId))
				throw new Error("Invalid conversationId");
			boolean(action.background, "background", true);
			break;
		case "rename":
			string(action.title, "title");
			break;
		case "pin":
			boolean(action.pinned, "pinned");
			break;
		case "search":
			if (typeof action.query !== "string") throw new Error("Invalid query");
			boolean(action.archived, "archived", true);
			break;
		case "prompt":
			if (
				action.attachments !== undefined &&
				(!Array.isArray(action.attachments) ||
					action.attachments.length > 20 ||
					!action.attachments.every((id) => typeof id === "string"))
			)
				throw new Error("Invalid attachments");
			if (typeof action.content !== "string" || (!action.content.trim() && !action.attachments?.length))
				throw new Error("Invalid content");
			break;
	}
	if (action.type === "prompt") {
		string(action.requestId, "requestId");
		if (action.whenBusy !== undefined && !["steer", "followUp", "reject"].includes(String(action.whenBusy)))
			throw new Error("Invalid whenBusy");
	}
	return request as ClientRequest;
}
