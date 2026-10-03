import type { AuthEvent, AuthPrompt, AuthType } from "@earendil-works/pi-ai";

type WithoutSignal<P = AuthPrompt> = P extends AuthPrompt ? Omit<P, "signal"> : never;
export type LoginPrompt = WithoutSignal & { id: string };
export type LoginEvent =
	| { type: "started"; attemptId: string; providerId: string; authType: AuthType }
	| { type: "prompt"; attemptId: string; prompt: LoginPrompt }
	| { type: "promptClosed"; attemptId: string; promptId: string }
	| { type: "notice"; attemptId: string; event: AuthEvent }
	| { type: "finished"; attemptId: string; status: "success" | "cancelled" | "error"; message?: string };
