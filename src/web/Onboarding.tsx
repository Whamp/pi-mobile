import type { ResourceSnapshot } from "../shared/resources.ts";
import { Sheet } from "./Sheet.tsx";

export function Onboarding({
	resources,
	onProviders,
	onClose,
}: {
	resources?: ResourceSnapshot;
	onProviders: () => void;
	onClose: () => void;
}) {
	return (
		<Sheet title="Welcome to p2w" onClose={onClose}>
			<div className="onboarding stack">
				<span className="logo big">π</span>
				<h3>Your agent. On this phone.</h3>
				<p>Sessions, code execution, and files stay on this device. Model requests go to your provider.</p>
				<p className="muted small">
					New sessions use GPT-6.1 Sol with high thinking. Luna, GLM-5.3 Flash, GLM-5.3, and Kimi K3-256K are also
					available after sign-in.
				</p>
				<button type="button" className="button primary block" onClick={onProviders}>
					Sign in to providers
				</button>
				<p className="muted small">
					OpenAI Codex and Kimi support browser sign-in. Z.AI uses an API key. You can return to setup from
					Providers.
				</p>
				<a className="button block" href="/android/notifications">
					Allow the running notification
				</a>
				<a className="button block" href="/android/battery">
					Keep p2w running in the background
				</a>
				<p className="muted small">
					Set battery use to Unrestricted. Force-stop pauses work until you reopen p2w; reopening resumes saved
					work.
				</p>
				{resources?.fake && <p className="banner">Debug fake provider is on. Tools still run on this phone.</p>}
				<button type="button" className="button ghost block" onClick={onClose}>
					Skip for now
				</button>
			</div>
		</Sheet>
	);
}
