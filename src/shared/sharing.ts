export type GuestAccess = {
	kind: "guest";
	id: string;
	name: string;
	shareId: string;
	sessionId: string;
	canSend: boolean;
	canStop: boolean;
	expiresAt: number | null;
};
export type Access = { kind: "owner" } | GuestAccess;
export type Author = { kind: "owner" | "guest"; id: string; name: string };
export type ShareSettings = { canSend: boolean; canStop: boolean; expiresAt: number | null };
export type ShareInfo = ShareSettings & {
	id: string;
	token: string;
	url?: string;
	guests: { id: string; name: string; muted: boolean; removed: boolean; lastSeen: number }[];
};
export const SPEAKER_PREFIX = "<mobile-speaker>";
export function speakerText(author: Author): string {
	return `${SPEAKER_PREFIX}${JSON.stringify(author)}</mobile-speaker>`;
}
