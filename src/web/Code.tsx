import { common, createLowlight } from "lowlight";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { CheckIcon, CopyIcon } from "./icons.tsx";

const lowlight = createLowlight(common);
const ALIASES: Record<string, string> = { mjs: "js", cjs: "js", mts: "ts", cts: "ts", jsonc: "json", zsh: "bash" };

/** Highlight.js language for a fence info string or a file path, if registered. */
export function languageOf(hint: string | undefined): string | undefined {
	if (!hint) return undefined;
	const name = hint.toLowerCase().split(/[\s{]/)[0]?.split(/[/\\]/).pop() ?? "";
	const key = name.includes(".") ? (name.split(".").pop() ?? "") : name;
	const language = ALIASES[key] ?? key;
	return language && lowlight.registered(language) ? language : undefined;
}

type HastNode = {
	type: string;
	value?: string;
	properties?: { className?: unknown };
	children?: HastNode[];
};

function render(nodes: readonly HastNode[], key: string): ReactNode[] {
	return nodes.map((node, index) => {
		const id = `${key}.${index}`;
		if (node.type === "text") return node.value ?? "";
		const className = Array.isArray(node.properties?.className) ? node.properties.className.join(" ") : undefined;
		return (
			<span key={id} className={className}>
				{render(node.children ?? [], id)}
			</span>
		);
	});
}

// Rendered as React elements from lowlight's tree: never as HTML.
function highlight(code: string, language: string | undefined): ReactNode {
	if (!language || code.length > 100_000) return code;
	try {
		return render(lowlight.highlight(language, code).children as unknown as HastNode[], "h");
	} catch {
		return code;
	}
}

export async function copyText(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		// Clipboard API unavailable (insecure context, permissions): legacy fallback.
		const area = document.createElement("textarea");
		area.value = text;
		area.style.position = "fixed";
		area.style.opacity = "0";
		document.body.append(area);
		area.select();
		const copied = document.execCommand("copy");
		area.remove();
		return copied;
	}
}

export function CopyButton({ text, label }: { text: string; label?: string }) {
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		if (!copied) return;
		const timer = setTimeout(() => setCopied(false), 1500);
		return () => clearTimeout(timer);
	}, [copied]);
	return (
		<button
			type="button"
			className={`copy ${copied ? "done" : ""}`}
			aria-label={copied ? "Copied" : "Copy"}
			onClick={() => {
				void copyText(text).then(setCopied);
			}}
		>
			{copied ? <CheckIcon /> : <CopyIcon />}
			{label && <span>{copied ? "Copied" : label}</span>}
		</button>
	);
}

export function CodeBlock({ code, language, tool }: { code: string; language?: string; tool?: boolean }) {
	const resolved = languageOf(language);
	const content = useMemo(() => highlight(code, resolved), [code, resolved]);
	if (tool)
		return (
			<pre className="code hljs">
				<code>{content}</code>
			</pre>
		);
	return (
		<div className="code-block">
			<div className="code-head">
				<span>{language || "text"}</span>
				<CopyButton text={code} label="Copy" />
			</div>
			<pre className="hljs">
				<code>{content}</code>
			</pre>
		</div>
	);
}
