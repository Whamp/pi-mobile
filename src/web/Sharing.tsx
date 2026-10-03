import { useEffect, useState } from "react";
import type { ShareInfo } from "../shared/sharing.ts";
import { CopyButton } from "./Code.tsx";
import type { MobileClient } from "./client.ts";
import { Sheet } from "./Sheet.tsx";

export function Sharing({
	client,
	sessionId,
	onClose,
}: {
	client: MobileClient;
	sessionId: string;
	onClose: () => void;
}) {
	const [share, setShare] = useState<ShareInfo | null>();
	const [canSend, setCanSend] = useState(false);
	const [canStop, setCanStop] = useState(false);
	const [expiry, setExpiry] = useState("86400000");
	const [working, setWorking] = useState(false);
	const [error, setError] = useState<string>();
	useEffect(() => {
		let active = true;
		const load = () =>
			void client
				.request<ShareInfo | null>({ type: "shareGet", sessionId })
				.then((next) => {
					if (!active) return;
					setShare(next);
				})
				.catch((reason: Error) => active && setError(reason.message));
		void client
			.request<ShareInfo | null>({ type: "shareGet", sessionId })
			.then((next) => {
				if (!active) return;
				setShare(next);
				setCanSend(next?.canSend ?? false);
				setCanStop(next?.canStop ?? false);
				if (next?.expiresAt === null) setExpiry("never");
			})
			.catch((reason: Error) => active && setError(reason.message));
		const timer = setInterval(load, 5000);
		return () => {
			active = false;
			clearInterval(timer);
		};
	}, [client, sessionId]);
	async function save(reset: boolean) {
		setWorking(true);
		setError(undefined);
		try {
			setShare(
				await client.request<ShareInfo>({
					type: "shareSet",
					sessionId,
					reset,
					settings: { canSend, canStop, expiresAt: expiry === "never" ? null : Date.now() + Number(expiry) },
				}),
			);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setWorking(false);
		}
	}
	async function changeGuest(id: string, muted: boolean, removed: boolean) {
		try {
			setShare(await client.request<ShareInfo>({ type: "shareGuest", sessionId, guestId: id, muted, removed }));
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		}
	}
	return (
		<Sheet title="Share session" onClose={onClose}>
			<div className="stack">
				<p className="muted">
					Anyone with this reusable link can join this session and its subagents. Guests choose an unverified name.
				</p>
				<label className="inline-form">
					<input type="checkbox" checked={canSend} onChange={(event) => setCanSend(event.target.checked)} /> Allow
					sending messages and uploads
				</label>
				<label className="inline-form">
					<input type="checkbox" checked={canStop} onChange={(event) => setCanStop(event.target.checked)} /> Allow
					stopping the current run
				</label>
				<p className="notice">
					Sending includes steering and follow-ups in all conversations. It can cause the agent to run shell
					commands and access files. This is not filesystem isolation.
				</p>
				<label className="label" htmlFor="share-expiry">
					Link expiry
				</label>
				<select
					className="input"
					id="share-expiry"
					value={expiry}
					onChange={(event) => setExpiry(event.target.value)}
				>
					<option value="3600000">One hour from save</option>
					<option value="86400000">One day from save</option>
					<option value="604800000">One week from save</option>
					<option value="never">No expiry</option>
				</select>
				<button type="button" className="button primary block" disabled={working} onClick={() => void save(false)}>
					{share ? "Update access" : "Create share link"}
				</button>
				{share && (
					<>
						<input
							className="input mono"
							readOnly
							aria-label="Share link"
							value={share.url ?? `${location.origin}/join/${share.token}`}
						/>
						<CopyButton text={share.url ?? `${location.origin}/join/${share.token}`} />
						<p className="muted small">
							{share.expiresAt === null ? "No expiry" : `Expires ${new Date(share.expiresAt).toLocaleString()}`}
						</p>
						<div className="inline-form">
							<button
								type="button"
								className="button"
								disabled={working}
								onClick={() => {
									if (confirm("Reset the link and disconnect all current guests?")) void save(true);
								}}
							>
								Reset link
							</button>
							<button
								type="button"
								className="button danger"
								onClick={() => {
									if (confirm("Revoke this share and disconnect all guests?"))
										void client
											.request({ type: "shareRevoke", sessionId })
											.then(() => setShare(null))
											.catch((reason: Error) => setError(reason.message));
								}}
							>
								Revoke
							</button>
						</div>
						<div className="list">
							<span className="label">Guests</span>
							{!share.guests.length && <p className="muted">No guests yet.</p>}
							{share.guests.map((guest) => (
								<div className="guest-row" key={guest.id}>
									<span>
										{guest.name}
										<small className="muted">
											{" "}
											{guest.removed ? "removed" : guest.muted ? "muted" : "guest"}
										</small>
									</span>
									{!guest.removed && (
										<span className="inline-form">
											<button
												type="button"
												className="button small"
												onClick={() => void changeGuest(guest.id, !guest.muted, false)}
											>
												{guest.muted ? "Unmute" : "Mute"}
											</button>
											<button
												type="button"
												className="button small danger"
												onClick={() => void changeGuest(guest.id, guest.muted, true)}
											>
												Remove
											</button>
										</span>
									)}
								</div>
							))}
						</div>
						<p className="muted small">
							Removal blocks this guest identity. A reusable link can still be used in another browser; reset or
							revoke it to prevent rejoining.
						</p>
					</>
				)}
				{error && (
					<p className="notice error" role="alert">
						{error}
					</p>
				)}
			</div>
		</Sheet>
	);
}
