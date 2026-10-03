import { type ReactNode, useEffect } from "react";
import { CloseIcon } from "./icons.tsx";

// Bottom sheet on phones, centered dialog on wide screens.
export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
	useEffect(() => {
		const key = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose();
		};
		window.addEventListener("keydown", key);
		return () => window.removeEventListener("keydown", key);
	}, [onClose]);
	return (
		<div className="sheet-layer">
			<button type="button" className="scrim" aria-label="Close" onClick={onClose} />
			<section className="sheet" role="dialog" aria-modal="true" aria-label={title}>
				<div className="grabber" />
				<header className="sheet-head">
					<h2>{title}</h2>
					<button type="button" className="icon-button" onClick={onClose} aria-label="Close">
						<CloseIcon />
					</button>
				</header>
				<div className="sheet-body">{children}</div>
			</section>
		</div>
	);
}
