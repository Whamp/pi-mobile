// Persistent background subagents, adapted from pi-durable's
// test/examples/23-subagent-background.ts (MIT; see third-party/pi.LICENSE).
// Adds per-subagent model, thinking level and tool selection.
import { type AssistantMessage, type ModelThinkingLevel, Type } from "@earendil-works/pi-ai";
import { clampThinkingLevel, type Models } from "@earendil-works/pi-ai/models";
import {
	AssistantEntry,
	type ConversationId,
	configure,
	defineDoc,
	defineExtension,
	defineTask,
	defineTool,
	type EntryId,
	LiveDoc,
	type TaskId,
	type ToolRegistration,
} from "@earendil-works/pi-durable";

export const SUBAGENT_EXTENSION = "subagent-tools";
const CODING_TOOLS = ["read", "write", "edit", "bash"];
const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

type Subagent = {
	conversationId: ConversationId;
	model: string;
	thinkingLevel: string;
	tools: string[];
	/** Answers already reported: several messages can end in one answer, reported once. */
	reported: EntryId[];
};
export type SubagentState = { agents: Record<string, Subagent>; reporters: Record<string, TaskId> };
export const Subagents = defineDoc<SubagentState>({
	kind: "mobile.subagents",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ agents: {}, reporters: {} }),
});

// Owns the subagent conversation. Background and immediately terminal, so the
// main agent's Stop and idle waits do not reach the subagent; abort({background})
// still does.
const Anchor = defineTask<null, { phase: "done" }, null>({
	name: "mobile.subagent-anchor",
	version: 1,
	initial: () => ({ phase: "done" }),
	phases: {
		done: (_anchor, runtime, context) =>
			runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context),
	},
	abort: (_anchor, runtime, context) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

function textOf(message: AssistantMessage | undefined): string {
	return (message?.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

// Delivers one message, waits for the answer, then reports it to the main agent
// as a follow-up input. Request IDs make both submissions exactly-once across restarts.
type ReporterInput = { name: string; conversationId: ConversationId; message: string; followUp: boolean };
type ReporterState = { phase: "deliver" } | { phase: "report"; report?: string };
const Reporter = defineTask<ReporterInput, ReporterState, null>({
	name: "mobile.subagent-reporter",
	version: 1,
	initial: () => ({ phase: "deliver" }),
	phases: {
		deliver: async (reporter, runtime, context) => {
			const { name, conversationId, message, followUp } = reporter.input;
			const subagent = await runtime.conversation(conversationId, context);
			if (!subagent) throw new Error(`Subagent ${name} has no conversation`);
			const submission = await subagent.submit(
				{
					type: "input",
					content: message,
					whenBusy: followUp ? "followUp" : "steer",
					requestId: `subagent:${reporter.id}`,
				},
				context,
			);
			const settled = await submission.wait(context);
			await runtime.commit(async (tx) => {
				const next = (report?: string) => ({ status: "running", checkpoint: { phase: "report", report } }) as const;
				if (settled.status === "unanswered")
					return next(settled.reason === "aborted" ? undefined : `[subagent ${name} failed] ${settled.reason}`);
				if (settled.type !== "input") return next();
				const agent = (await tx.doc(Subagents, runtime.conversationId)).agents[name];
				if (!agent || agent.reported.includes(settled.answer)) return next();
				agent.reported.push(settled.answer);
				const answer = (await tx.entry(AssistantEntry, settled.answer))?.model?.[0] as AssistantMessage | undefined;
				return next(`[subagent ${name} answered, no reply needed] ${textOf(answer)}`);
			}, context);
		},
		report: async (reporter, runtime, context) => {
			const report = reporter.state.checkpoint.report;
			if (report !== undefined) {
				const main = await runtime.conversation(runtime.conversationId, context);
				await main?.submit(
					{ type: "input", content: report, whenBusy: "followUp", requestId: `subagent-report:${reporter.id}` },
					context,
				);
			}
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
		},
	},
	abort: (_reporter, runtime, context) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

export type SubagentDetails = {
	action: string;
	name?: string;
	conversationId?: number;
	model?: string;
	thinkingLevel?: string;
	tools?: string[];
};

// TODO: use the tool API's models once pi-durable exposes them
// (earendil-works/pi#10395). Until then the host passes its Models instance.
export function createSubagentExtension(models: Models) {
	const tool = defineTool({
		name: "subagent",
		description: [
			"Manage persistent subagents that work in the background while you keep talking to the user.",
			"Each subagent is its own conversation with its own memory, working in your cwd.",
			"Actions:",
			"- spawn (name, message; optional model, thinkingLevel, tools): start a subagent and send its first message.",
			"  model is 'provider/modelId' (default: yours); thinkingLevel is off|minimal|low|medium|high|xhigh|max",
			"  (clamped to the model); tools is a subset of read, write, edit, bash (default: all; [] for none).",
			"- send (name, message; followUp: true queues after the current answer instead of steering).",
			"- stop (name): abort its current work; it stays usable.",
			"- status (optional name): list subagents and whether they are working.",
			"- models: list models that have credentials configured.",
			"Answers are reported back to you as messages when they arrive; do not wait or poll for them.",
		].join("\n"),
		parameters: Type.Object({
			action: Type.Union([
				Type.Literal("spawn"),
				Type.Literal("send"),
				Type.Literal("stop"),
				Type.Literal("status"),
				Type.Literal("models"),
			]),
			name: Type.Optional(Type.String()),
			message: Type.Optional(Type.String()),
			followUp: Type.Optional(Type.Boolean()),
			model: Type.Optional(Type.String()),
			thinkingLevel: Type.Optional(Type.String()),
			tools: Type.Optional(Type.Array(Type.String())),
		}),
		// A crash-interrupted stop must not be repeated against newer work.
		replay: "unsafe",
		execute: async (args, api, context) => {
			const { action, name, message, followUp } = args;
			const reply = (text: string, extra: Partial<SubagentDetails> = {}, isError = false) => ({
				content: [{ type: "text" as const, text }],
				details: { action, ...(name === undefined ? {} : { name }), ...extra } satisfies SubagentDetails,
				isError,
			});
			const registry = (await api.snapshot(Subagents, api.conversationId, context)) ?? { agents: {}, reporters: {} };

			if (action === "models") {
				const available = await models.getAvailable(undefined, { signal: AbortSignal.timeout(10_000) });
				const lines = available.slice(0, 200).map((model) => `${model.provider}/${model.id} (${model.name})`);
				return reply(lines.length ? lines.join("\n") : "No models with configured credentials.");
			}
			if (action === "status") {
				const names = name === undefined ? Object.keys(registry.agents) : [name];
				const lines: string[] = [];
				for (const each of names) {
					const agent = Object.hasOwn(registry.agents, each) ? registry.agents[each] : undefined;
					if (!agent) continue;
					const busy = (await api.snapshot(LiveDoc, agent.conversationId, context))?.run !== undefined;
					lines.push(
						`${each}: ${busy ? "working" : "idle"} · ${agent.model} · thinking ${agent.thinkingLevel} · tools ${agent.tools.join(", ") || "none"}`,
					);
				}
				return reply(lines.length ? lines.join("\n") : "No subagents.");
			}
			if (name === undefined || !name.trim()) return reply(`${action} needs a name.`, {}, true);
			const agent = Object.hasOwn(registry.agents, name) ? registry.agents[name] : undefined;
			if (action !== "spawn" && !agent) return reply(`No subagent named ${name}.`, {}, true);
			if (action === "stop" && agent) {
				await (await api.conversation(agent.conversationId, context))?.abort(context);
				return reply(`Stopped ${name}.`, { conversationId: agent.conversationId });
			}
			if (message === undefined || !message.trim()) return reply(`${action} needs a message.`, {}, true);

			// Validate spawn configuration before any commit, so a typo fails this call.
			let change: { model?: { provider: string; modelId: string }; thinkingLevel?: ModelThinkingLevel } = {};
			let tools: ToolRegistration[] = [];
			if (action === "spawn") {
				if (agent) return reply(`${name} already exists; use send.`, {}, true);
				const own = await api.agent(context);
				let ref = own.model;
				if (args.model !== undefined) {
					const slash = args.model.indexOf("/");
					ref =
						slash > 0
							? { provider: args.model.slice(0, slash), modelId: args.model.slice(slash + 1) }
							: undefined;
				}
				const model = ref ? models.getModel(ref.provider, ref.modelId) : undefined;
				if (!ref || !model)
					return reply(`Unknown model ${args.model ?? "(none)"}. Use action models to list them.`, {}, true);
				if (args.thinkingLevel !== undefined && !THINKING.includes(args.thinkingLevel))
					return reply(`Invalid thinkingLevel ${args.thinkingLevel}.`, {}, true);
				const requested = (args.thinkingLevel ?? own.thinkingLevel) as ModelThinkingLevel;
				change = { model: ref, thinkingLevel: clampThinkingLevel(model, requested) };
				const names = args.tools ?? CODING_TOOLS;
				const unknown = names.filter((tool) => !CODING_TOOLS.includes(tool));
				if (unknown.length)
					return reply(`Unknown tools: ${unknown.join(", ")}. Choose from ${CODING_TOOLS.join(", ")}.`, {}, true);
				const installed = api.registry.tools().map((entry) => entry.tool);
				tools = [...new Set(names)].flatMap((tool) => installed.filter((entry) => entry.name === tool).slice(0, 1));
			}

			const result = await api.commit(async (tx) => {
				const state = await tx.doc(Subagents, api.conversationId);
				const background = { ownership: { kind: "conversation" }, background: true } as const;
				if (action === "spawn") {
					if (Object.hasOwn(state.agents, name)) return `${name} already exists; use send.`;
					const anchor = await tx.createTask(Anchor, null, background);
					const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
					await configure(tx, child.id, {
						...change,
						extensions: { remove: [extension] }, // Subagents cannot start subagents.
						tools,
						instructions: `You are the subagent "${name}", working for a main agent. Do the requested work and answer concisely; your final answer is reported back to it.`,
					});
					state.agents[name] = {
						conversationId: child.id,
						model: `${change.model?.provider}/${change.model?.modelId}`,
						thinkingLevel: change.thinkingLevel ?? "off",
						tools: tools.map((tool) => tool.name),
						reported: [],
					};
				}
				const target = state.agents[name];
				if (!target) return `No subagent named ${name}.`;
				const input = {
					name,
					conversationId: target.conversationId,
					message,
					followUp: action === "send" && followUp === true,
				};
				state.reporters[api.taskId] = await tx.createTask(Reporter, input, background);
				return action === "send" ? `Sent to ${name}.` : `Started ${name}.`;
			}, context);
			const current = (await api.snapshot(Subagents, api.conversationId, context))?.agents[name];
			return reply(
				result,
				current
					? {
							conversationId: current.conversationId,
							model: current.model,
							thinkingLevel: current.thinkingLevel,
							tools: current.tools,
						}
					: {},
			);
		},
	});
	const extension = defineExtension({ name: SUBAGENT_EXTENSION, tasks: [Anchor, Reporter], tools: [tool] });
	return extension;
}
