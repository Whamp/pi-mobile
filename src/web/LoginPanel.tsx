import type { AuthEvent } from "@earendil-works/pi-ai";
import { useState } from "react";
import type { ResourceSnapshot } from "../shared/resources.ts";
import type { LoginView, MobileClient } from "./client.ts";
import { CheckIcon, ChevronIcon, SearchIcon } from "./icons.tsx";
import { Sheet } from "./Sheet.tsx";

function Link({ url, label }: { url: string; label: string }) {
	let safe = false;
	try {
		safe = ["http:", "https:"].includes(new URL(url).protocol);
	} catch {}
	return safe ? (
		<a className="button primary block" href={url} target="_blank" rel="noreferrer">
			{label}
		</a>
	) : (
		<span>{label}</span>
	);
}

function Notice({ event }: { event: AuthEvent }) {
	switch (event.type) {
		case "auth_url":
			return (
				<div className="login-step">
					<Link url={event.url} label="Continue in browser" />
					{event.instructions && <p className="muted small">{event.instructions}</p>}
				</div>
			);
		case "device_code":
			return (
				<div className="login-step">
					<p className="muted small">Enter this code on the verification page</p>
					<div className="code-box">{event.userCode}</div>
					<Link url={event.verificationUri} label="Open verification page" />
				</div>
			);
		case "progress":
			return <p className="muted small">{event.message}</p>;
		case "info":
			return (
				<div className="login-step">
					<p>{event.message}</p>
					{event.links?.map((link) => (
						<Link key={link.url} url={link.url} label={link.label ?? "More information"} />
					))}
				</div>
			);
	}
}

function PromptForm({ login, client }: { login: LoginView; client: MobileClient }) {
	const prompt = login.prompt;
	const [value, setValue] = useState("");
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string>();
	if (!prompt) return null;
	const answer = (input: string) => {
		setSending(true);
		setError(undefined);
		void client
			.request({ type: "loginAnswer", attemptId: login.attemptId, promptId: prompt.id, value: input })
			.then(() => setValue(""))
			.catch((failure: Error) => setError(failure.message))
			.finally(() => setSending(false));
	};
	if (prompt.type === "select")
		return (
			<div className="login-step">
				<p>{prompt.message}</p>
				<div className="list">
					{prompt.options.map((option) => (
						<button
							type="button"
							key={option.id}
							className="row-button"
							disabled={sending}
							onClick={() => answer(option.id)}
						>
							<span>{option.label}</span>
							<ChevronIcon />
						</button>
					))}
				</div>
				{error && <p className="error small">{error}</p>}
			</div>
		);
	return (
		<form
			className="login-step"
			onSubmit={(event) => {
				event.preventDefault();
				answer(value);
			}}
		>
			<label className="label" htmlFor="login-value">
				{prompt.message}
			</label>
			<input
				id="login-value"
				className="input"
				type={prompt.type === "secret" ? "password" : "text"}
				autoComplete="off"
				placeholder={prompt.placeholder}
				value={value}
				onChange={(event) => setValue(event.target.value)}
			/>
			{error && <p className="error small">{error}</p>}
			<button type="submit" className="button primary block" disabled={sending}>
				Continue
			</button>
		</form>
	);
}

export function LoginPanel({
	client,
	resources,
	login,
	onClose,
	onSetup,
}: {
	client: MobileClient;
	resources?: ResourceSnapshot;
	login?: LoginView;
	onClose: () => void;
	onSetup?: () => void;
}) {
	const [providerId, setProviderId] = useState<string>();
	const [query, setQuery] = useState("");
	const working = login?.status === "working";
	const close = () => {
		if (working && login) void client.request({ type: "cancelLogin", attemptId: login.attemptId }).catch(() => {});
		client.dismissLogin();
		onClose();
	};
	const perform = (operation: Promise<unknown>) => {
		void operation.catch((error: Error) => client.setError(error.message));
	};
	const stored = new Map(resources?.credentials.map((credential) => [credential.providerId, credential.type]));
	const provider = resources?.providers.find((entry) => entry.id === (login?.providerId ?? providerId));
	if (provider) {
		const credential = stored.get(provider.id);
		return (
			<Sheet title={provider.name} onClose={close}>
				{!login && (
					<>
						<p className="muted small">
							{credential
								? `Signed in with ${credential === "oauth" ? "a subscription" : "an API key"}.`
								: "Not signed in. Environment keys may still apply."}{" "}
							Credentials stay on this device.
						</p>
						<div className="stack">
							{provider.loginMethods.map((method) => (
								<button
									type="button"
									key={method.type}
									className="button primary block"
									onClick={() =>
										perform(client.request({ type: "login", providerId: provider.id, authType: method.type }))
									}
								>
									{method.label}
								</button>
							))}
							{credential && (
								<button
									type="button"
									className="button block"
									onClick={() => perform(client.request({ type: "refreshModels", providerId: provider.id }))}
								>
									Refresh models
								</button>
							)}
							{credential && (
								<button
									type="button"
									className="button danger block"
									onClick={() => perform(client.request({ type: "logout", providerId: provider.id }))}
								>
									Sign out
								</button>
							)}
							<button type="button" className="button ghost block" onClick={() => setProviderId(undefined)}>
								All providers
							</button>
						</div>
					</>
				)}
				{login && (
					<div className="stack">
						{login.notices.map((notice) => (
							<Notice key={notice.id} event={notice.event} />
						))}
						{login.prompt && <PromptForm key={login.prompt.id} login={login} client={client} />}
						{working && !login.prompt && !login.notices.length && <div className="spinner large" />}
						{login.status === "success" && (
							<p className="success">
								<CheckIcon /> {login.message ?? "Signed in."}
							</p>
						)}
						{login.status !== "working" && login.status !== "success" && (
							<p className={login.status === "error" ? "error" : "muted"}>{login.message}</p>
						)}
						{working ? (
							<button
								type="button"
								className="button block"
								onClick={() => perform(client.request({ type: "cancelLogin", attemptId: login.attemptId }))}
							>
								Cancel
							</button>
						) : (
							<button
								type="button"
								className="button block"
								onClick={() => {
									client.dismissLogin();
									setProviderId(undefined);
								}}
							>
								Done
							</button>
						)}
					</div>
				)}
			</Sheet>
		);
	}
	const terms = query.toLowerCase();
	const providers = (resources?.providers ?? [])
		.filter((entry) => entry.loginMethods.length && `${entry.name} ${entry.id}`.toLowerCase().includes(terms))
		.sort((a, b) => Number(stored.has(b.id)) - Number(stored.has(a.id)) || a.name.localeCompare(b.name));
	return (
		<Sheet title="Providers" onClose={close}>
			{onSetup && (
				<div className="stack">
					<button type="button" className="button block" onClick={onSetup}>
						Phone setup and onboarding
					</button>
					{resources?.debug && (
						<a className="button ghost block" href="/android/debug">
							Debug provider settings
						</a>
					)}
				</div>
			)}
			<label className="search">
				<SearchIcon />
				<input
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					placeholder="Search providers"
					aria-label="Search providers"
				/>
			</label>
			<div className="list">
				{providers.map((entry) => (
					<button type="button" key={entry.id} className="row-button" onClick={() => setProviderId(entry.id)}>
						<span>
							{entry.name}
							{stored.has(entry.id) && <span className="pill">Signed in</span>}
						</span>
						<ChevronIcon />
					</button>
				))}
			</div>
		</Sheet>
	);
}
