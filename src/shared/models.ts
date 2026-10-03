import { type CreateModelsOptions, createModels } from "@earendil-works/pi-ai/models";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxThinking,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { SPEAKER_PREFIX } from "./sharing.ts";

// Explicit demo/test mode. Responses depend on committed input, not a volatile
// queue position, so reopening an interrupted request is deterministic.
export function createMobileModels(fake: boolean, options: CreateModelsOptions = {}) {
	if (!fake) return builtinModels(options);
	const models = createModels(options);
	const faux = fauxProvider({ api: "pi-mobile-faux", tokensPerSecond: 200, tokenSize: { min: 4, max: 4 } });
	models.setProvider({
		...faux.provider,
		streamSimple(model, context, options) {
			faux.appendResponses([
				(transcript) => {
					const user = transcript.messages.findLast((message) => message.role === "user");
					const text =
						typeof user?.content === "string"
							? user.content
							: ((user?.content[0]?.type === "text" && user.content[0].text.startsWith(SPEAKER_PREFIX)
									? user.content.slice(1)
									: user?.content
								)
									?.filter((part) => part.type === "text")
									.map((part) => part.text)
									.join("\n") ?? "");
					const last = transcript.messages.at(-1);
					if (last?.role !== "toolResult") {
						const call =
							text === "tool"
								? fauxToolCall("read", { path: "fixture.txt" })
								: text === "write"
									? fauxToolCall("write", { path: "created.txt", content: "before\n" })
									: text === "edit"
										? fauxToolCall("edit", {
												path: "created.txt",
												edits: [{ oldText: "before", newText: "after" }],
											})
										: text === "bash"
											? fauxToolCall("bash", { command: "pwd" })
											: text === "subagent"
												? fauxToolCall("subagent", {
														action: "spawn",
														name: "helper",
														message: "hello helper",
														thinkingLevel: "high",
														tools: ["read"],
													})
												: text === "subagent-bad"
													? fauxToolCall("subagent", {
															action: "spawn",
															name: "bad",
															message: "x",
															model: "nope/missing",
														})
													: text === "slow-tool"
														? fauxToolCall("bash", {
																command: "printf tool-running; sleep 4; printf tool-finished",
															})
														: undefined;
						if (call)
							return fauxAssistantMessage(
								[fauxText(text === "tool" ? "Reading fixture." : `Running ${call.name}.`), call],
								{ stopReason: "toolUse" },
							);
					}
					return fauxAssistantMessage([
						fauxThinking("private-thinking-sentinel"),
						fauxText(text.startsWith("slow") ? `Echo: ${text} ${"streaming ".repeat(300)}` : `Echo: ${text}`),
					]);
				},
			]);
			return faux.provider.streamSimple(model, context, options);
		},
	});
	return models;
}
