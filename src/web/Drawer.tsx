import { useEffect, useState } from "react";
import type { SearchResults, SessionSummary } from "../shared/protocol.ts";
import type { MobileClient } from "./client.ts";
import { ArchiveIcon, FolderIcon, KeyIcon, PinIcon, PlusIcon, SearchIcon } from "./icons.tsx";

export function shortPath(path: string): string {
	return path.replace(/^\/data\/data\/com\.termux\/files\/home/, "~").replace(/^\/home\/[^/]+/, "~");
}

function ago(time: number): string {
	const seconds = Math.max(0, (Date.now() - time) / 1000);
	if (seconds < 60) return "now";
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
	if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
	if (seconds < 604800) return `${Math.floor(seconds / 86400)}d`;
	return new Date(time).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function Drawer({
	client,
	sessions,
	activeId,
	conversationId,
	connected,
	onOpen,
	onNew,
	onProviders,
}: {
	client: MobileClient;
	sessions: SessionSummary[];
	activeId?: string;
	conversationId: number;
	connected: boolean;
	onOpen: (id: string, conversationId?: number) => void;
	onNew: () => void;
	onProviders: () => void;
}) {
	const [query, setQuery] = useState("");
	const [archived, setArchived] = useState(false);
	const [results, setResults] = useState<SearchResults>();
	useEffect(() => {
		if (!connected || !query.trim()) {
			setResults(undefined);
			return;
		}
		let current = true;
		const timer = setTimeout(() => {
			void client
				.request<SearchResults>({ type: "search", query, archived })
				.then((value) => current && setResults(value))
				.catch(() => {});
		}, 200);
		return () => {
			current = false;
			clearTimeout(timer);
		};
	}, [client, query, archived, connected]);
	const ids = results ? new Set(results.sessions.map((session) => session.id)) : undefined;
	const visible = sessions.filter(
		(session) => Boolean(session.archivedAt) === archived && (!ids || ids.has(session.id)),
	);
	const groups = new Map<string, SessionSummary[]>();
	for (const session of visible) groups.set(session.cwd, [...(groups.get(session.cwd) ?? []), session]);
	// Most recently active directory first; pinned sessions first inside a directory.
	const ordered = [...groups].sort(
		([, a], [, b]) => Math.max(...b.map((s) => s.updatedAt)) - Math.max(...a.map((s) => s.updatedAt)),
	);
	for (const [, list] of ordered)
		list.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
	const restore = (id: string) =>
		void client
			.request({ type: "restore", sessionId: id })
			.then(() => onOpen(id))
			.catch((error: Error) => client.setError(error.message));
	return (
		<nav className="drawer-content" aria-label="Sessions">
			<div className="drawer-top">
				<div className="brand">
					<span className="logo">π</span>
					<span>Pi</span>
				</div>
				<button type="button" className="button primary small" onClick={onNew} disabled={!connected}>
					<PlusIcon size={16} /> New
				</button>
			</div>
			<label className="search">
				<SearchIcon />
				<input
					type="search"
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					placeholder={archived ? "Search archive" : "Search sessions"}
					aria-label="Search sessions and messages"
				/>
			</label>
			<div className="session-scroll">
				{ordered.map(([cwd, list]) => (
					<section key={cwd} className="group">
						<h3 title={cwd}>
							<FolderIcon /> {shortPath(cwd)}
						</h3>
						{list.map((session) => (
							<div key={session.id} className="session-row">
								<button
									type="button"
									className={`session-main ${session.id === activeId && conversationId === 1 ? "active" : ""}`}
									onClick={() => (archived ? restore(session.id) : onOpen(session.id))}
								>
									<span className="session-title">
										{session.pinned && <PinIcon size={12} />}
										{session.title}
									</span>
									<span className="session-meta">
										{session.worker.busy?.includes(1) && <span className="live-dot" title="Working" />}
										{archived ? "Tap to restore" : ago(session.updatedAt)}
									</span>
								</button>
								{!archived &&
									(session.subagents ?? []).map((agent) => (
										<button
											type="button"
											key={agent.conversationId}
											className={`subagent-row ${session.id === activeId && conversationId === agent.conversationId ? "active" : ""}`}
											onClick={() => onOpen(session.id, agent.conversationId)}
										>
											<span className="branch" />
											<span className="session-title">{agent.name}</span>
											<span className="session-meta">
												{session.worker.busy?.includes(agent.conversationId) && (
													<span className="live-dot" title="Working" />
												)}
												{agent.model.split("/").pop()}
											</span>
										</button>
									))}
							</div>
						))}
					</section>
				))}
				{results && results.messages.length > 0 && (
					<section className="group">
						<h3>Messages</h3>
						{results.messages.slice(0, 40).map((hit) => (
							<button
								type="button"
								key={`${hit.sessionId}-${hit.entryId}`}
								className="hit"
								onClick={() => (archived ? restore(hit.sessionId) : onOpen(hit.sessionId))}
							>
								<strong>{hit.title}</strong>
								<span>{hit.text.slice(0, 160)}</span>
							</button>
						))}
					</section>
				)}
				{!visible.length && !results?.messages.length && (
					<p className="muted empty-note">
						{query ? "Nothing found." : archived ? "No archived sessions." : "No sessions yet."}
					</p>
				)}
			</div>
			<div className="drawer-foot">
				<button type="button" className="foot-button" onClick={() => setArchived(!archived)}>
					<ArchiveIcon /> {archived ? "Back to sessions" : "Archived"}
				</button>
				<button type="button" className="foot-button" onClick={onProviders}>
					<KeyIcon /> Providers
				</button>
			</div>
		</nav>
	);
}
