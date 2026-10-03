import type { AssistantMessage, ImageContent } from "@earendil-works/pi-ai";
import { createContext, useContext, useState } from "react";
import { CodeBlock, CopyButton } from "./Code.tsx";
import {
	AlertIcon,
	BotIcon,
	CheckIcon,
	ChevronIcon,
	FileIcon,
	PencilIcon,
	SparkIcon,
	TerminalIcon,
	ToolIcon,
} from "./icons.tsx";
import { Markdown } from "./Markdown.tsx";
import type { Item, ToolView, Transcript } from "./transcript.ts";

/** Opens a subagent conversation of the current session. */
export const OpenConversation = createContext<(conversationId: number) => void>(() => {});

function str(value: unknown): string {
	return typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value);
}

function Images({ images }: { images: ImageContent[] }) {
	if (!images.length) return null;
	return (
		<div className="images">
			{images.map((image, index) => (
				<img key={`${image.mimeType}-${index}`} src={`data:${image.mimeType};base64,${image.data}`} alt="" />
			))}
		</div>
	);
}

function Diff({ diff }: { diff: string }) {
	return (
		<pre className="diff">
			{diff.split("\n").map((line, index) => (
				<span
					key={`${index}:${line}`}
					className={line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : undefined}
				>
					{line}
					{"\n"}
				</span>
			))}
		</pre>
	);
}

function tail(output: string, lines: number): string {
	const all = output.replace(/\n$/, "").split("\n");
	return all.slice(-lines).join("\n");
}

function ToolCard({ tool }: { tool: ToolView }) {
	const [open, setOpen] = useState(false);
	const openConversation = useContext(OpenConversation);
	const active = tool.status === "running" || tool.status === "pending";
	const path = str(tool.args.path);
	const details = tool.details && typeof tool.details === "object" && !Array.isArray(tool.details) ? tool.details : {};
	const diff = typeof details.diff === "string" ? details.diff : undefined;
	let icon = <ToolIcon />;
	let title = tool.name;
	let summary = "";
	let body: React.ReactNode = null;
	let preview: string | undefined;
	let extra: React.ReactNode = null;
	switch (tool.name) {
		case "bash":
			icon = <TerminalIcon />;
			title = "";
			summary = str(tool.args.command);
			body = tool.output ? <pre className="term">{tool.output}</pre> : null;
			preview = tool.output ? tail(tool.output, 4) : undefined;
			break;
		case "read": {
			icon = <FileIcon />;
			title = "Read";
			const range =
				tool.args.offset !== undefined || tool.args.limit !== undefined
					? `:${str(tool.args.offset ?? 1)}${tool.args.limit !== undefined ? `+${str(tool.args.limit)}` : ""}`
					: "";
			summary = `${path}${range}`;
			body = tool.output ? <CodeBlock tool code={tool.output} language={path} /> : null;
			break;
		}
		case "write":
			icon = <FileIcon />;
			title = "Write";
			summary = path;
			body = <CodeBlock tool code={str(tool.args.content)} language={path} />;
			if (tool.status === "error") body = <pre className="code">{tool.output}</pre>;
			break;
		case "subagent": {
			icon = <BotIcon />;
			const action = str(tool.args.action);
			title = action ? `Subagent ${action}` : "Subagent";
			summary = [str(tool.args.name), str(tool.args.message)].filter(Boolean).join(" · ");
			const target = typeof details.conversationId === "number" ? details.conversationId : undefined;
			const config = [
				details.model,
				details.thinkingLevel && `thinking ${str(details.thinkingLevel)}`,
				Array.isArray(details.tools) && `tools ${details.tools.join(", ") || "none"}`,
			]
				.filter(Boolean)
				.join(" · ");
			body = (
				<div className="tool-sub">
					{tool.args.message !== undefined && <Markdown text={str(tool.args.message)} />}
					{config && <p className="mono muted">{config}</p>}
					{tool.output && <pre className="code">{tool.output}</pre>}
				</div>
			);
			if (target !== undefined)
				extra = (
					<button type="button" className="tool-link" onClick={() => openConversation(target)}>
						Open {str(details.name)} →
					</button>
				);
			break;
		}
		case "edit":
			icon = <PencilIcon />;
			title = "Edit";
			summary = path;
			body = diff ? <Diff diff={diff} /> : tool.output ? <pre className="code">{tool.output}</pre> : null;
			break;
		default:
			summary = Object.keys(tool.args).length ? JSON.stringify(tool.args) : "";
			body = (
				<>
					{Object.keys(tool.args).length > 0 && <pre className="code">{JSON.stringify(tool.args, null, 2)}</pre>}
					{tool.output && <pre className="code">{tool.output}</pre>}
				</>
			);
	}
	return (
		<div className={`tool ${tool.status}`}>
			<button type="button" className="tool-head" onClick={() => setOpen(!open)} aria-expanded={open}>
				<span className="tool-icon">{icon}</span>
				{title && <span className="tool-name">{title}</span>}
				<span className="tool-summary">{summary}</span>
				<span className="tool-state" title={tool.status}>
					{active ? (
						<span className="spinner" />
					) : tool.status === "done" ? (
						<CheckIcon />
					) : tool.status === "interrupted" ? (
						"interrupted"
					) : (
						<AlertIcon />
					)}
				</span>
				<span className={`chev ${open ? "open" : ""}`}>
					<ChevronIcon size={14} />
				</span>
			</button>
			{open && body && <div className="tool-body">{body}</div>}
			{!open && active && preview && <pre className="tool-preview">{preview}</pre>}
			{!open && tool.status === "error" && tool.output && (
				<pre className="tool-preview err">{tail(tool.output, 3)}</pre>
			)}
			{extra}
			<Images images={tool.images} />
		</div>
	);
}

function Thinking({ text, live }: { text: string; live: boolean }) {
	const [open, setOpen] = useState(false);
	return (
		<div className={`thinking ${live ? "live" : ""}`}>
			<button type="button" onClick={() => setOpen(!open)} aria-expanded={open}>
				<SparkIcon size={14} />
				<span>{live ? "Thinking…" : "Thought"}</span>
				<span className={`chev ${open ? "open" : ""}`}>
					<ChevronIcon size={13} />
				</span>
			</button>
			{(open || live) && <div className={open ? "thinking-body" : "thinking-body clamp"}>{text}</div>}
		</div>
	);
}

function Assistant({
	message,
	tools,
	streaming,
}: {
	message: AssistantMessage;
	tools: ToolView[];
	streaming: boolean;
}) {
	const byId = new Map(tools.map((tool) => [tool.id, tool]));
	const parts = message.content;
	const lastText = parts.findLastIndex((part) => part.type === "text");
	const thinkingLive = streaming && parts.at(-1)?.type === "thinking";
	const answer = parts
		.flatMap((part) => (part.type === "text" ? [part.text] : []))
		.join("\n\n")
		.trim();
	return (
		<div className="assistant">
			{parts.map((part, index) => {
				const key = `${part.type}-${index}`;
				if (part.type === "thinking")
					return part.thinking.trim() ? (
						<Thinking key={key} text={part.thinking} live={thinkingLive && index === parts.length - 1} />
					) : null;
				if (part.type === "text")
					return (
						<div key={key} className={streaming && index === lastText ? "streaming" : undefined}>
							<Markdown text={part.text} />
						</div>
					);
				if (part.type === "toolCall") {
					const tool = byId.get(part.id) ?? {
						id: part.id,
						name: part.name,
						args: part.arguments ?? {},
						status: "pending" as const,
						output: "",
						images: [],
					};
					return <ToolCard key={part.id} tool={tool} />;
				}
				return null;
			})}
			{(message.stopReason === "error" || message.stopReason === "aborted") && !streaming && (
				<div className={`notice ${message.stopReason === "error" ? "error" : ""}`}>
					{message.stopReason === "aborted"
						? "Stopped"
						: message.errorMessage || "The provider returned an error."}
				</div>
			)}
			{answer && !streaming && (
				<div className="message-actions">
					<CopyButton text={answer} />
				</div>
			)}
		</div>
	);
}

function Report({ name, status, text }: { name: string; status: string; text: string }) {
	const [open, setOpen] = useState(false);
	const failed = status.startsWith("failed");
	return (
		<div className={`report ${failed ? "failed" : ""}`}>
			<button type="button" className="report-head" onClick={() => setOpen(!open)} aria-expanded={open}>
				<BotIcon />
				<span>
					<strong>{name}</strong> {failed ? "failed" : "answered"}
				</span>
				<span className={`chev ${open ? "open" : ""}`}>
					<ChevronIcon size={13} />
				</span>
			</button>
			{text && (
				<div className={open ? "report-body" : "report-body clamp"}>{failed ? text : <Markdown text={text} />}</div>
			)}
		</div>
	);
}

function ItemView({ item }: { item: Item }) {
	switch (item.type) {
		case "user": {
			// Subagent answers arrive as follow-up inputs; show them as reports.
			const report = !item.author && /^\[subagent (\S+) ([^\]]*)\] ?([\s\S]*)$/.exec(item.text);
			if (report) return <Report name={report[1] ?? ""} status={report[2] ?? ""} text={report[3] ?? ""} />;
			return (
				<div className={`user ${item.author?.kind === "guest" ? "guest-message" : ""}`}>
					<div className="bubble">
						{item.author && (
							<div
								className="speaker"
								style={
									item.author.kind === "guest"
										? {
												color: `hsl(${[...item.author.id].reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 360, 0)} 65% 55%)`,
											}
										: undefined
								}
							>
								{item.author.kind === "owner" ? "Owner" : `${item.author.name} · guest`}
							</div>
						)}
						{item.text}
						{item.files.length > 0 && (
							<div className="bubble-files">
								{item.files.map((file) => (
									<span key={file}>{file}</span>
								))}
							</div>
						)}
						<Images images={item.images} />
					</div>
				</div>
			);
		}
		case "assistant":
			return <Assistant message={item.message} tools={item.tools} streaming={item.streaming} />;
		case "tool":
			return (
				<div className="assistant">
					<ToolCard tool={item.tool} />
				</div>
			);
		case "marker":
			return (
				<details className="marker">
					<summary>{item.label}</summary>
					{item.detail && <Markdown text={item.detail} />}
				</details>
			);
	}
}

export function Messages({ transcript }: { transcript: Transcript }) {
	return (
		<div className="messages">
			{transcript.items.map((item) => (
				<ItemView key={item.key} item={item} />
			))}
			{transcript.working && (
				<output className="working" aria-label="Working">
					<span />
					<span />
					<span />
				</output>
			)}
			{transcript.retry && (
				<div className="notice">Provider error, retrying… {transcript.retry.error.slice(0, 200)}</div>
			)}
		</div>
	);
}
