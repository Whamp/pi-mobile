import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { SessionSummary } from "../shared/protocol.ts";
import { ContextUsage, Messages, OpenConversation, UsageLine } from "./Chat.tsx";
import { MobileClient } from "./client.ts";
import { Drawer, shortPath } from "./Drawer.tsx";
import {
	ArchiveIcon,
	AttachIcon,
	ChevronIcon,
	CloseIcon,
	DownIcon,
	FolderIcon,
	MenuIcon,
	MoreIcon,
	PinIcon,
	SendIcon,
	SparkIcon,
	StopIcon,
} from "./icons.tsx";
import { LoginPanel } from "./LoginPanel.tsx";
import { type ModelChoice, ModelPicker, modelName } from "./ModelPicker.tsx";
import { Onboarding } from "./Onboarding.tsx";
import { OwnerToken } from "./OwnerToken.tsx";
import { Sharing } from "./Sharing.tsx";
import { Sheet } from "./Sheet.tsx";
import { buildTranscript } from "./transcript.ts";

type PickedFile = { key: string; file: File; preview?: string; uploaded?: string };

async function upload(sessionId: string, file: File): Promise<string> {
	const query = new URLSearchParams({ session: sessionId, name: file.name });
	const response = await fetch(`/upload?${query}`, { method: "POST", body: file, credentials: "same-origin" });
	const result = (await response.json().catch(() => ({}))) as { id?: string; error?: string };
	if (!response.ok || !result.id) throw new Error(`Upload of ${file.name} failed: ${result.error ?? response.status}`);
	return result.id;
}

type Panel = "model" | "providers" | "session" | "cwd" | "owner-token" | "share" | "onboarding" | undefined;

export function App() {
	const client = useMemo(() => new MobileClient(), []);
	const state = useSyncExternalStore(client.subscribe, client.snapshot, client.snapshot);
	const { resources, sessions, view, activeId, connected, conversationId } = state;
	const owner = state.access?.kind === "owner";
	const guest = state.access?.kind === "guest" ? state.access : undefined;
	const canSend = owner || guest?.canSend === true;
	const canStop = owner || guest?.canStop === true;
	const [drawer, setDrawer] = useState(false);
	const [panel, setPanel] = useState<Panel>();
	useEffect(() => {
		if (resources?.profile === "p2w" && owner && !localStorage.getItem("p2w-onboarded")) {
			localStorage.setItem("p2w-onboarded", "1");
			setPanel("onboarding");
		}
	}, [resources?.profile, owner]);
	const [draft, setDraft] = useState("");
	const [steer, setSteer] = useState(true);
	const [sending, setSending] = useState(false);
	const [files, setFiles] = useState<PickedFile[]>([]);
	const [newCwd, setNewCwd] = useState<string>();
	const [newChoice, setNewChoice] = useState<ModelChoice>();
	const submission = useRef<{ text: string; id: string } | undefined>(undefined);
	const scroller = useRef<HTMLDivElement>(null);
	const pinned = useRef(true);
	const [atBottom, setAtBottom] = useState(true);
	const textarea = useRef<HTMLTextAreaElement>(null);

	useEffect(() => {
		client.start();
		return () => client.stop();
	}, [client]);

	const active = sessions.find((session) => session.id === activeId);
	const subagent =
		conversationId === 1 ? undefined : active?.subagents?.find((agent) => agent.conversationId === conversationId);
	const transcript = useMemo(() => (view ? buildTranscript(view) : undefined), [view]);
	const busy = transcript?.busy ?? false;

	// New sessions: last used directory and the saved default model.
	const recentCwds = [...new Set([...sessions].sort((a, b) => b.updatedAt - a.updatedAt).map((s) => s.cwd))];
	const cwd = newCwd ?? recentCwds[0] ?? "~";
	const fallbackModel =
		resources?.settings.defaultModel ?? sessions.toSorted((a, b) => b.updatedAt - a.updatedAt)[0]?.model;
	const draftChoice: ModelChoice | undefined =
		newChoice ??
		(fallbackModel ? { model: fallbackModel, thinkingLevel: resources?.settings.thinkingLevel ?? "off" } : undefined);
	const sessionChoice: ModelChoice | undefined = active
		? {
				model: transcript?.agent.model ?? active.model,
				thinkingLevel: transcript?.agent.thinkingLevel ?? active.thinkingLevel,
			}
		: undefined;
	const choice = active ? sessionChoice : draftChoice;

	const perform = useCallback(
		(operation: Promise<unknown>) => {
			void operation.catch((error: Error) => client.setError(error.message));
		},
		[client],
	);

	// Follow the stream only while the reader is at the bottom.
	useLayoutEffect(() => {
		const element = scroller.current;
		if (element && pinned.current) element.scrollTop = element.scrollHeight;
	}, [transcript]);
	useLayoutEffect(() => {
		pinned.current = true;
		setAtBottom(true);
		const element = scroller.current;
		if (element) element.scrollTop = element.scrollHeight;
	}, [activeId]);
	const onScroll = () => {
		const element = scroller.current;
		if (!element) return;
		const bottom = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
		pinned.current = bottom;
		setAtBottom(bottom);
	};
	const toBottom = () => {
		pinned.current = true;
		scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
	};

	useLayoutEffect(() => {
		const element = textarea.current;
		if (!element) return;
		element.style.height = "auto";
		element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
	}, [draft]);

	function open(id: string, conversation = 1) {
		setDrawer(false);
		perform(client.open(id, conversation));
	}

	function startNew() {
		setDrawer(false);
		setNewChoice(undefined);
		client.leave();
		setTimeout(() => textarea.current?.focus(), 50);
	}

	function choose(next: ModelChoice) {
		if (!active) {
			setNewChoice(next);
			return;
		}
		perform(
			client.request({
				type: "configure",
				sessionId: active.id,
				model: next.model,
				thinkingLevel: next.thinkingLevel,
			}),
		);
	}

	async function send() {
		const text = draft.trim();
		if ((!text && !files.length) || sending || !connected || !canSend) return;
		const key = `${activeId ?? "new"}:${conversationId}:${text}\u0000${files.map((file) => file.key).join()}`;
		if (submission.current?.text !== key) submission.current = { text: key, id: crypto.randomUUID() };
		const requestId = submission.current.id;
		setSending(true);
		pinned.current = true;
		try {
			let sessionId = activeId;
			if (!sessionId) {
				if (!draftChoice) {
					setPanel("model");
					return;
				}
				if (
					resources?.profile === "p2w" &&
					!resources.fake &&
					!resources.credentials.some((credential) => credential.providerId === draftChoice.model.provider)
				) {
					setPanel("providers");
					return;
				}
				const session = await client.request<SessionSummary>({
					type: "create",
					cwd,
					model: draftChoice.model,
					thinkingLevel: draftChoice.thinkingLevel,
				});
				sessionId = session.id;
				await client.open(sessionId);
			}
			// Upload at send time, once per picked file even across retries.
			const attachments: string[] = [];
			for (const file of files) {
				file.uploaded ??= await upload(sessionId, file.file);
				attachments.push(file.uploaded);
			}
			await client.request({
				type: "prompt",
				sessionId,
				content: text,
				conversationId,
				...(attachments.length ? { attachments } : {}),
				requestId,
				whenBusy: steer ? "steer" : "followUp",
			});
			setDraft("");
			setFiles([]);
			setSteer(true);
			submission.current = undefined;
		} catch (error) {
			client.setError(
				error instanceof Error ? error.message : "Message was not acknowledged. Check the chat before retrying.",
			);
		} finally {
			setSending(false);
		}
	}

	// Spend covers the whole session; context belongs only to the viewed conversation
	// and uses the active model's live context limit (including models.json overrides).
	const contextWindow = resources?.models.find(
		(model) => model.provider === choice?.model.provider && model.modelId === choice?.model.modelId,
	)?.contextWindow;
	const sessionUsage = active && (
		<div className="session-usage">
			{active.worker.usage && (
				<UsageLine usage={active.worker.usage} title="Session total: all conversations, subagents and tools" />
			)}
			{transcript && contextWindow !== undefined && contextWindow > 0 && (
				<>
					{active.worker.usage && <span className="usage"> · </span>}
					<ContextUsage used={transcript.contextTokens} limit={contextWindow} />
				</>
			)}
		</div>
	);

	// Stop withdraws queued steers/follow-ups. The server returns each author's own
	// items to their connections; prepend them to the composer as one draft.
	useEffect(
		() =>
			client.onRestore((texts) => {
				setDraft((current) => [...texts, current].filter((part) => part.trim()).join("\n\n"));
				submission.current = undefined;
				textarea.current?.focus();
			}),
		[client],
	);
	function stop() {
		if (activeId) perform(client.request({ type: "abort", sessionId: activeId, conversationId }));
	}
	function editQueued(submissionId: number) {
		if (!activeId) return;
		perform(
			client
				.request<{ texts: string[] }>({
					type: "dequeue",
					sessionId: activeId,
					conversationId,
					submissionId,
					restore: true,
				})
				.then(({ texts }) => {
					if (!texts.length) return;
					setDraft((current) => [current, ...texts].filter((part) => part.trim()).join("\n\n"));
					submission.current = undefined;
					textarea.current?.focus();
				}),
		);
	}

	const levelLabel = choice && choice.thinkingLevel !== "off" ? choice.thinkingLevel : undefined;
	const modelChip = (
		<button
			type="button"
			className="chip"
			onClick={() => setPanel("model")}
			disabled={!resources || !owner || Boolean(subagent)}
		>
			<SparkIcon size={14} />
			<span className="chip-text">{choice ? modelName(resources, choice.model) : "Choose model"}</span>
			{levelLabel && <span className="chip-sub">{levelLabel}</span>}
		</button>
	);

	return (
		<div className={`app ${drawer ? "drawer-open" : ""}`}>
			<aside className="drawer">
				<Drawer
					client={client}
					guest={guest}
					sessions={sessions}
					activeId={activeId}
					conversationId={conversationId}
					connected={connected}
					onOpen={open}
					onNew={startNew}
					onOwnerLink={() => {
						setDrawer(false);
						setPanel("owner-token");
					}}
					onProviders={() => {
						setDrawer(false);
						setPanel("providers");
					}}
				/>
			</aside>
			<button
				type="button"
				className="drawer-scrim"
				aria-label="Close sessions"
				onClick={() => setDrawer(false)}
				tabIndex={drawer ? 0 : -1}
			/>
			<main className="main">
				<header className="topbar">
					<button type="button" className="icon-button menu" onClick={() => setDrawer(true)} aria-label="Sessions">
						<MenuIcon />
					</button>
					<div className="title">
						{subagent ? (
							<>
								<h1>
									<span className="sub-tag">subagent</span> {subagent.name}
								</h1>
								<button type="button" className="crumb" onClick={() => active && open(active.id)}>
									← {active?.title}
								</button>
							</>
						) : (
							<>
								<h1>{active?.title ?? "New session"}</h1>
								{active && <p>{shortPath(active.cwd)}</p>}
							</>
						)}
					</div>
					{!connected && <span className="offline">Offline</span>}
					{owner && active && !subagent && (
						<button
							type="button"
							className="icon-button"
							onClick={() => setPanel("session")}
							aria-label="Session options"
						>
							<MoreIcon />
						</button>
					)}
				</header>
				{state.error && (
					<button type="button" className="toast" onClick={() => client.setError()}>
						{state.error}
					</button>
				)}
				{active?.worker.error && <div className="banner">{active.worker.error}</div>}
				{resources?.fake && <div className="banner">Debug · fake provider · tools run on this phone</div>}

				<div className="scroller" ref={scroller} onScroll={onScroll}>
					{transcript && active ? (
						transcript.items.length ? (
							<OpenConversation.Provider value={(id) => active && open(active.id, id)}>
								<Messages transcript={transcript} />
							</OpenConversation.Provider>
						) : (
							<div className="hero small-hero">
								<p className="muted">Send a message to start.</p>
							</div>
						)
					) : activeId ? (
						<div className="hero">
							<div className="spinner large" />
						</div>
					) : (
						<div className="hero">
							<span className="logo big">π</span>
							<h2>What are we building?</h2>
							<button type="button" className="cwd-pick" onClick={() => setPanel("cwd")}>
								<FolderIcon />
								<span>{shortPath(cwd)}</span>
								<ChevronIcon size={14} />
							</button>
							{resources && !resources.credentials.length && (
								<button type="button" className="button small" onClick={() => setPanel("providers")}>
									Sign in to a provider
								</button>
							)}
						</div>
					)}
				</div>

				{subagent && (
					<div className="composer-wrap">
						<div className="subagent-bar">
							<span>
								{subagent.model} · thinking {subagent.thinkingLevel} · tools{" "}
								{subagent.tools.join(", ") || "none"}
							</span>
							{busy && !canSend && canStop && (
								<button
									type="button"
									className="round stop"
									aria-label="Stop subagent"
									onClick={() =>
										activeId &&
										perform(
											client.request({
												type: "abort",
												sessionId: activeId,
												conversationId: subagent.conversationId,
											}),
										)
									}
								>
									<StopIcon />
								</button>
							)}
						</div>
					</div>
				)}
				{canSend ? (
					<div className="composer-wrap">
						{!atBottom && (
							<button type="button" className="to-bottom" onClick={toBottom} aria-label="Scroll to bottom">
								<DownIcon />
							</button>
						)}
						{transcript && transcript.queued.length > 0 && (
							<div className="queued">
								{transcript.queued.map((item) => (
									<div key={item.id}>
										<button
											type="button"
											className="queue-edit"
											title="Move back to editor"
											disabled={!canStop}
											onClick={() => editQueued(item.id)}
										>
											<span>{item.mode === "steer" ? "Steer" : "Queued"}</span> {item.text}
										</button>
										{canStop && (
											<button
												type="button"
												className="queue-remove"
												aria-label="Remove from queue"
												onClick={() =>
													activeId &&
													perform(
														client.request({
															type: "dequeue",
															sessionId: activeId,
															conversationId,
															submissionId: item.id,
														}),
													)
												}
											>
												<CloseIcon />
											</button>
										)}
									</div>
								))}
							</div>
						)}
						<form
							className="composer"
							onSubmit={(event) => {
								event.preventDefault();
								void send();
							}}
						>
							{files.length > 0 && (
								<div className="attachments">
									{files.map((file) => (
										<span key={file.key} className="attachment">
											{file.preview ? <img src={file.preview} alt="" /> : <AttachIcon />}
											<span className="attachment-name">{file.file.name}</span>
											<button
												type="button"
												aria-label={`Remove ${file.file.name}`}
												onClick={() => setFiles((current) => current.filter((entry) => entry !== file))}
											>
												<CloseIcon />
											</button>
										</span>
									))}
								</div>
							)}
							<textarea
								ref={textarea}
								rows={1}
								value={draft}
								placeholder={busy ? (steer ? "Steer the current run…" : "Queue a follow-up…") : "Message Pi…"}
								aria-label="Message"
								onChange={(event) => {
									setDraft(event.target.value);
									if (submission.current?.text !== event.target.value.trim()) submission.current = undefined;
								}}
								onKeyDown={(event) => {
									// Enter sends on wide screens; phones use the send button for newlines.
									if (
										event.key === "Enter" &&
										!event.shiftKey &&
										window.matchMedia("(pointer: fine)").matches
									) {
										event.preventDefault();
										void send();
									}
								}}
							/>
							<div className="composer-bar">
								<label className="round attach" aria-label="Attach files">
									<AttachIcon />
									<input
										type="file"
										multiple
										hidden
										onChange={(event) => {
											const picked = [...(event.target.files ?? [])];
											event.target.value = "";
											const tooLarge = picked.find((file) => file.size > 25 * 1024 * 1024);
											if (tooLarge) client.setError(`${tooLarge.name} is larger than 25 MB`);
											setFiles((current) => [
												...current,
												...picked
													.filter((file) => file.size <= 25 * 1024 * 1024)
													.map((file) => ({
														key: crypto.randomUUID(),
														file,
														...(file.type.startsWith("image/")
															? { preview: URL.createObjectURL(file) }
															: {}),
													})),
											]);
										}}
									/>
								</label>
								{owner ? (
									modelChip
								) : (
									<span className="chip">
										<span className="chip-text">{guest?.name} · guest</span>
									</span>
								)}
								{busy && (
									<button
										type="button"
										className={`chip toggle ${steer ? "on" : ""}`}
										onClick={() => setSteer(!steer)}
									>
										Steer
									</button>
								)}
								<span className="spacer" />
								{busy && canStop && (
									<button type="button" className="round stop" aria-label="Stop" onClick={stop}>
										<StopIcon />
									</button>
								)}
								{(!busy || !canStop || draft.trim() || files.length > 0) && (
									<button
										type="submit"
										className="round send"
										aria-label="Send"
										disabled={(!draft.trim() && !files.length) || sending || !connected}
									>
										<SendIcon />
									</button>
								)}
							</div>
						</form>
						{sessionUsage}
					</div>
				) : (
					<div className="composer-wrap">
						<div className="subagent-bar">
							<span>{guest ? `Joined as ${guest.name} · View only` : "Connecting…"}</span>
							{busy && canStop && !subagent && (
								<button
									type="button"
									className="round stop"
									aria-label="Stop"
									onClick={() =>
										activeId &&
										perform(client.request({ type: "abort", sessionId: activeId, conversationId }))
									}
								>
									<StopIcon />
								</button>
							)}
						</div>
					</div>
				)}
			</main>

			{panel === "share" && owner && active && (
				<Sharing client={client} sessionId={active.id} onClose={() => setPanel(undefined)} />
			)}
			{panel === "owner-token" && owner && <OwnerToken onClose={() => setPanel(undefined)} />}
			{panel === "model" && (
				<ModelPicker
					resources={resources}
					value={choice}
					title={active ? "Session model" : "Model"}
					onChange={(next) => choose(next)}
					onClose={() => setPanel(undefined)}
				/>
			)}
			{panel === "providers" && (
				<LoginPanel
					client={client}
					resources={resources}
					login={state.login}
					onClose={() => setPanel(undefined)}
					onSetup={resources?.profile === "p2w" ? () => setPanel("onboarding") : undefined}
				/>
			)}
			{panel === "onboarding" && (
				<Onboarding
					resources={resources}
					onProviders={() => setPanel("providers")}
					onClose={() => setPanel(undefined)}
				/>
			)}
			{panel === "cwd" && (
				<CwdSheet
					value={cwd}
					recent={recentCwds}
					onChange={(value) => {
						setNewCwd(value);
						setPanel(undefined);
					}}
					onClose={() => setPanel(undefined)}
				/>
			)}
			{panel === "session" && active && (
				<SessionSheet
					session={active}
					onShare={() => setPanel("share")}
					onClose={() => setPanel(undefined)}
					onRename={(title) => perform(client.request({ type: "rename", sessionId: active.id, title }))}
					onPin={() => perform(client.request({ type: "pin", sessionId: active.id, pinned: !active.pinned }))}
					onArchive={() => {
						setPanel(undefined);
						perform(client.request({ type: "archive", sessionId: active.id }).then(() => client.leave()));
					}}
					onDefault={() =>
						choice &&
						resources &&
						perform(
							client.request({
								type: "setSettings",
								settings: {
									...resources.settings,
									defaultModel: choice.model,
									thinkingLevel: choice.thinkingLevel as ModelThinkingLevel,
								},
							}),
						)
					}
				/>
			)}
		</div>
	);
}

function CwdSheet({
	value,
	recent,
	onChange,
	onClose,
}: {
	value: string;
	recent: string[];
	onChange: (value: string) => void;
	onClose: () => void;
}) {
	const [input, setInput] = useState(shortPath(value));
	return (
		<Sheet title="Working directory" onClose={onClose}>
			<form
				className="stack"
				onSubmit={(event) => {
					event.preventDefault();
					if (input.trim()) onChange(input.trim());
				}}
			>
				<input
					className="input mono"
					value={input}
					onChange={(event) => setInput(event.target.value)}
					aria-label="Directory"
					autoCapitalize="off"
					autoCorrect="off"
					spellCheck={false}
				/>
				<button type="submit" className="button primary block">
					Use directory
				</button>
			</form>
			{recent.length > 0 && (
				<div className="list">
					<span className="label">Recent</span>
					{recent.slice(0, 8).map((path) => (
						<button type="button" key={path} className="row-button mono" onClick={() => onChange(path)}>
							<span>{shortPath(path)}</span>
							<ChevronIcon />
						</button>
					))}
				</div>
			)}
		</Sheet>
	);
}

function SessionSheet({
	session,
	onClose,
	onRename,
	onPin,
	onArchive,
	onDefault,
	onShare,
}: {
	session: SessionSummary;
	onClose: () => void;
	onRename: (title: string) => void;
	onPin: () => void;
	onArchive: () => void;
	onDefault: () => void;
	onShare: () => void;
}) {
	const [title, setTitle] = useState(session.title);
	return (
		<Sheet title="Session" onClose={onClose}>
			<form
				className="stack"
				onSubmit={(event) => {
					event.preventDefault();
					if (title.trim()) onRename(title.trim());
					onClose();
				}}
			>
				<label className="label" htmlFor="session-title">
					Title
				</label>
				<div className="inline-form">
					<input
						id="session-title"
						className="input"
						value={title}
						onChange={(event) => setTitle(event.target.value)}
					/>
					<button type="submit" className="button">
						Save
					</button>
				</div>
			</form>
			<div className="list">
				<button type="button" className="row-button" onClick={onShare}>
					<span>Share session…</span>
				</button>
				<button type="button" className="row-button" onClick={onPin}>
					<span>
						<PinIcon /> {session.pinned ? "Unpin" : "Pin to top"}
					</span>
				</button>
				<button
					type="button"
					className="row-button"
					onClick={() => {
						onDefault();
						onClose();
					}}
				>
					<span>
						<SparkIcon /> Use this model for new sessions
					</span>
				</button>
				<button type="button" className="row-button danger" onClick={onArchive}>
					<span>
						<ArchiveIcon /> Archive
					</span>
				</button>
			</div>
			<p className="muted small mono">{session.cwd}</p>
		</Sheet>
	);
}
