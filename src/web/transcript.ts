import type { JsonValue } from "@earendil-works/chord";
import type { AssistantMessage, ImageContent, ToolResultMessage } from "@earendil-works/pi-ai";
import type { AgentState, ConversationView, InboxState, LiveState, ToolSlot } from "@earendil-works/pi-durable";

// Pure display model of a Durable view: tool calls are joined with their live
// slot and result entry, so one card follows a call from request to result.
export type ToolStatus = "pending" | "running" | "done" | "error" | "interrupted";
export type ToolView = {
	id: string;
	name: string;
	args: Record<string, unknown>;
	status: ToolStatus;
	output: string;
	details?: JsonValue;
	images: ImageContent[];
};
export type Item =
	| { type: "user"; key: string; text: string; images: ImageContent[]; files: string[] }
	| { type: "assistant"; key: string; message: AssistantMessage; tools: ToolView[]; streaming: boolean }
	| { type: "marker"; key: string; label: string; detail?: string }
	| { type: "tool"; key: string; tool: ToolView };
export type Transcript = {
	items: Item[];
	busy: boolean;
	working: boolean;
	retry?: { at: number; error: string };
	queued: { id: number; mode: string; text: string }[];
	agent: AgentState;
};

function text(content: string | readonly { type: string; text?: string }[]): string {
	return typeof content === "string"
		? content
		: content
				.filter((part) => part.type === "text")
				.map((part) => part.text ?? "")
				.join("\n");
}

function resultTool(result: ToolResultMessage, name = result.toolName): ToolView {
	return {
		id: result.toolCallId,
		name,
		args: {},
		status: result.isError ? "error" : "done",
		output: text(result.content),
		details: result.details as JsonValue | undefined,
		images: result.content.filter((part) => part.type === "image"),
	};
}

/** Separate the attachment note the worker appends from what the user typed. */
export function splitAttachments(value: string): { text: string; files: string[] } {
	const match = /(?:\n\n)?<attachments>\n[^\n]*\n([\s\S]*?)\n<\/attachments>$/.exec(value);
	if (!match) return { text: value, files: [] };
	const files = (match[1] ?? "")
		.split("\n")
		.map((line) => /\(([^,]+), \d+ bytes\)$/.exec(line)?.[1] ?? line.replace(/^- /, ""));
	return { text: value.slice(0, match.index), files };
}

export function buildTranscript(view: ConversationView): Transcript {
	const live = view.docs["pi.live"] as unknown as LiveState | undefined;
	const inbox = view.docs["pi.inbox"] as unknown as InboxState | undefined;
	const busy = Boolean(live?.run);
	const results = new Map<string, ToolResultMessage>();
	for (const entry of view.entries) {
		const message = entry.model?.[0];
		if (message?.role === "toolResult") results.set(message.toolCallId, message);
	}
	const slots = new Map<string, ToolSlot>((live?.tools ?? []).map((slot) => [slot.callId, slot]));
	const called = new Set<string>();
	const items: Item[] = [];
	for (const entry of view.entries) {
		const message = entry.model?.[0];
		const key = String(entry.id);
		if (entry.kind === "pi.compaction") {
			items.push({ type: "marker", key, label: "Context compacted", detail: message ? text(message.content) : "" });
		} else if (entry.kind === "pi.reset") {
			items.push({ type: "marker", key, label: "New context" });
			if (message?.role === "user")
				items.push({ type: "user", key: `${key}-handoff`, text: text(message.content), images: [], files: [] });
		} else if (message?.role === "user") {
			const images =
				typeof message.content === "string" ? [] : message.content.filter((part) => part.type === "image");
			items.push({ type: "user", key, images, ...splitAttachments(text(message.content)) });
		} else if (message?.role === "assistant") {
			const tools = message.content.flatMap((part): ToolView[] => {
				if (part.type !== "toolCall") return [];
				called.add(part.id);
				const result = results.get(part.id);
				const slot = slots.get(part.id);
				if (result)
					return [
						{
							...resultTool(result, part.name),
							args: part.arguments,
							...(slot?.output && !text(result.content) ? { output: slot.output } : {}),
						},
					];
				const status: ToolStatus = slot
					? slot.status === "done"
						? "error"
						: slot.status
					: busy
						? "pending"
						: "interrupted";
				return [
					{
						id: part.id,
						name: part.name,
						args: part.arguments,
						status,
						output: slot?.output ?? "",
						details: slot?.details,
						images: [],
					},
				];
			});
			items.push({ type: "assistant", key, message, tools, streaming: false });
		} else if (message?.role === "toolResult" && !called.has(message.toolCallId)) {
			items.push({ type: "tool", key, tool: resultTool(message) });
		}
	}
	const partial = live?.generation?.message as unknown as AssistantMessage | undefined;
	if (partial) items.push({ type: "assistant", key: "live", message: partial, tools: [], streaming: true });
	return {
		items,
		busy,
		working: busy && !partial && !live?.tools?.some((slot) => slot.status === "running"),
		...(live?.generation?.retry ? { retry: live.generation.retry } : {}),
		queued: (inbox?.items ?? []).flatMap((item) =>
			item.mode === "write" ? [] : [{ id: item.id, mode: item.mode, text: text(item.content as string) }],
		),
		agent: (view.docs["pi.agent"] ?? {}) as AgentState,
	};
}
