import { useEffect, useState } from "react";
import { CopyButton } from "./Code.tsx";
import { Sheet } from "./Sheet.tsx";

export function OwnerToken({ onClose }: { onClose: () => void }) {
	const [token, setToken] = useState<string>();
	const [error, setError] = useState<string>();
	const [generation, setGeneration] = useState(0);
	useEffect(() => {
		let current = true;
		setToken(undefined);
		setError(undefined);
		void (async () => {
			const response = await fetch("/owner-token", { credentials: "same-origin", cache: "no-store" });
			if (!response.ok)
				throw new Error("Generate owner tokens on the phone using Pi's local address, not through the tunnel.");
			const result: unknown = await response.json();
			if (!result || typeof result !== "object" || !("token" in result) || typeof result.token !== "string")
				throw new Error("Could not generate a sign-in token.");
			if (current) setToken(result.token);
		})().catch((failure: Error) => {
			if (current) setError(failure.message);
		});
		return () => {
			current = false;
		};
	}, [generation]);
	return (
		<Sheet title="Sign in another device" onClose={onClose}>
			<div className="stack">
				<p>This token grants full owner access. Give it only to your own device, not to collaborators.</p>
				<p className="muted small">
					Open Pi's domain on the other device, paste this token into the sign-in page, and tap Sign in. It expires
					after ten minutes and works once.
				</p>
				{error ? (
					<p className="error" role="alert">
						{error}
					</p>
				) : token ? (
					<>
						<label className="label" htmlFor="owner-token">
							One-time sign-in token
						</label>
						<textarea
							id="owner-token"
							className="input mono"
							rows={3}
							readOnly
							value={token}
							onFocus={(event) => event.target.select()}
							style={{ height: "auto", padding: "12px", resize: "none" }}
						/>
						<CopyButton key={token} text={token} label="Copy token" />
						<button type="button" className="button block" onClick={() => setGeneration((value) => value + 1)}>
							Generate fresh token
						</button>
					</>
				) : (
					<output className="muted">Generating token…</output>
				)}
			</div>
		</Sheet>
	);
}
