import { Fragment, type ReactNode } from "react";
import { CodeBlock } from "./Code.tsx";

// Small Markdown subset rendered as React elements: never HTML injection.
// Fences, headings, lists, quotes, rules, paragraphs and inline code/bold/italic/links.
function inline(source: string, key: string): ReactNode[] {
	const nodes: ReactNode[] = [];
	const pattern = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*|_[^_\n]+_)|(\[[^\]\n]+\]\([^)\s]+\))/g;
	let last = 0;
	let index = 0;
	for (const match of source.matchAll(pattern)) {
		if (match.index > last) nodes.push(source.slice(last, match.index));
		const token = match[0];
		const id = `${key}-${index++}`;
		if (match[1]) nodes.push(<code key={id}>{token.slice(1, -1)}</code>);
		else if (match[2]) nodes.push(<strong key={id}>{inline(token.slice(2, -2), id)}</strong>);
		else if (match[3]) nodes.push(<em key={id}>{inline(token.slice(1, -1), id)}</em>);
		else {
			const [, label = "", url = ""] = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token) ?? [];
			nodes.push(
				/^https?:\/\//.test(url) ? (
					<a key={id} href={url} target="_blank" rel="noreferrer">
						{label}
					</a>
				) : (
					label
				),
			);
		}
		last = match.index + token.length;
	}
	if (last < source.length) nodes.push(source.slice(last));
	return nodes;
}

export function Markdown({ text }: { text: string }) {
	const blocks: ReactNode[] = [];
	const lines = text.split("\n");
	let i = 0;
	while (i < lines.length) {
		const line = lines[i] ?? "";
		const key = `b${i}`;
		const fence = /^\s*(```|~~~)\s*(\S*)/.exec(line);
		if (fence) {
			const body: string[] = [];
			i++;
			while (i < lines.length && !(lines[i] ?? "").trim().startsWith(fence[1] ?? "```")) body.push(lines[i++] ?? "");
			i++;
			blocks.push(<CodeBlock key={key} code={body.join("\n")} language={fence[2] || undefined} />);
			continue;
		}
		const heading = /^(#{1,6})\s+(.*)$/.exec(line);
		if (heading) {
			const level = Math.min((heading[1] ?? "#").length + 2, 6);
			const Tag = `h${level}` as "h3" | "h4" | "h5" | "h6";
			blocks.push(<Tag key={key}>{inline(heading[2] ?? "", key)}</Tag>);
			i++;
			continue;
		}
		if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
			blocks.push(<hr key={key} />);
			i++;
			continue;
		}
		const list = /^\s*([-*+]|\d+[.)])\s+/.exec(line);
		if (list) {
			const ordered = /\d/.test(list[1] ?? "");
			const items: ReactNode[] = [];
			while (i < lines.length) {
				const current = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i] ?? "");
				if (!current) {
					// Indented continuation belongs to the previous item.
					if (/^\s{2,}\S/.test(lines[i] ?? "") && items.length) {
						i++;
						continue;
					}
					break;
				}
				items.push(<li key={`${key}-${i}`}>{inline(current[2] ?? "", `${key}-${i}`)}</li>);
				i++;
			}
			blocks.push(ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>);
			continue;
		}
		if (line.startsWith(">")) {
			const quote: string[] = [];
			while (i < lines.length && (lines[i] ?? "").startsWith(">"))
				quote.push((lines[i++] ?? "").replace(/^>\s?/, ""));
			blocks.push(
				<blockquote key={key}>
					<Markdown text={quote.join("\n")} />
				</blockquote>,
			);
			continue;
		}
		if (!line.trim()) {
			i++;
			continue;
		}
		const paragraph: string[] = [];
		while (
			i < lines.length &&
			(lines[i] ?? "").trim() &&
			!/^\s*(```|~~~|#{1,6}\s|>|[-*+]\s|\d+[.)]\s)/.test(lines[i] ?? "")
		)
			paragraph.push(lines[i++] ?? "");
		blocks.push(
			<p key={key}>
				{paragraph.map((part, index) => (
					<Fragment key={`${key}-${index}`}>
						{index > 0 && <br />}
						{inline(part, `${key}-${index}`)}
					</Fragment>
				))}
			</p>,
		);
	}
	return <div className="md">{blocks}</div>;
}
