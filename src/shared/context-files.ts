// Skill frontmatter/prompt conventions adapted from earendil-works/pi (MIT).
// See third-party/pi.LICENSE. This host uses only mobile + cwd-local skill roots.
import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parse } from "yaml";
import { stripBom } from "./config-json.ts";

type Skill = { name: string; description: string; path: string; disabled: boolean };
export type PromptResources = { agents: string; skills: string; fingerprint: string };

export async function optionalText(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
		throw new Error("Could not read resource file");
	}
}

function escapeXml(text: string): string {
	return text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

async function skillFiles(path: string): Promise<string[]> {
	let entries: Dirent[];
	try {
		entries = await readdir(path, { withFileTypes: true });
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
		throw new Error("Could not scan skills directory");
	}
	if (entries.some((entry) => entry.isFile() && entry.name === "SKILL.md")) return [join(path, "SKILL.md")];
	const nested = await Promise.all(
		entries
			.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules")
			.sort((a, b) => a.name.localeCompare(b.name))
			.map((entry) => skillFiles(join(path, entry.name))),
	);
	return nested.flat(); // Do not follow symlinks/cycles or scan unrelated project files.
}

export async function loadPromptResources(directory: string, cwd: string): Promise<PromptResources> {
	const ancestors: string[] = [];
	for (let path = resolve(cwd); ; path = dirname(path)) {
		ancestors.unshift(path);
		if (path === dirname(path)) break;
	}
	const agentFiles = [...new Set([join(directory, "AGENTS.md"), ...ancestors.map((path) => join(path, "AGENTS.md"))])];
	const agents: string[] = [];
	const fingerprint: string[] = [];
	for (const path of agentFiles) {
		const content = await optionalText(path);
		fingerprint.push(`${path}\n${content ?? ""}`);
		if (content !== undefined) agents.push(`## ${path}\n${stripBom(content)}`);
	}
	const skills = new Map<string, Skill>();
	const paths = [
		...new Set([...(await skillFiles(join(directory, "skills"))), ...(await skillFiles(join(cwd, ".pi", "skills")))]),
	];
	for (const path of paths) {
		const content = await optionalText(path);
		if (content === undefined) continue;
		fingerprint.push(`${path}\n${content}`);
		const normalized = stripBom(content).replace(/\r\n?/g, "\n");
		const end = normalized.indexOf("\n---", 4);
		if (!normalized.startsWith("---\n") || end < 0) throw new Error("Invalid skill frontmatter");
		let parsed: unknown;
		try {
			parsed = parse(normalized.slice(4, end));
		} catch {
			throw new Error("Invalid skill frontmatter");
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid skill frontmatter");
		const value = parsed as Record<string, unknown>;
		const name = value.name ?? basename(dirname(path));
		const description = value.description;
		if (
			typeof name !== "string" ||
			!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) ||
			name.length > 64 ||
			typeof description !== "string" ||
			!description.trim() ||
			description.length > 1024
		)
			throw new Error("Invalid skill name or description");
		if (!skills.has(name))
			skills.set(name, { name, description, path, disabled: value["disable-model-invocation"] === true });
	}
	const visible = [...skills.values()].filter((skill) => !skill.disabled);
	const prompt =
		visible.length === 0
			? ""
			: [
					"Use the read tool to load a skill's file when the task matches its description.",
					"Resolve relative paths against the skill's directory.",
					"<available_skills>",
					...visible.map(
						(skill) =>
							`<skill><name>${escapeXml(skill.name)}</name><description>${escapeXml(skill.description)}</description><location>${escapeXml(skill.path)}</location></skill>`,
					),
					"</available_skills>",
				].join("\n");
	return { agents: agents.join("\n\n"), skills: prompt, fingerprint: fingerprint.join("\n\0\n") };
}
