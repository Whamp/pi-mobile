import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelRef } from "@earendil-works/pi-durable";

export const P2W_MODELS: readonly (ModelRef & { thinkingLevel?: ModelThinkingLevel })[] = [
	{ provider: "openai-codex", modelId: "gpt-6.1-sol", thinkingLevel: "high" },
	{ provider: "openai-codex", modelId: "gpt-6-luna", thinkingLevel: "max" },
	{ provider: "zai", modelId: "glm-5.3-flash", thinkingLevel: "max" },
	{ provider: "zai", modelId: "glm-5.3", thinkingLevel: "max" },
	{ provider: "kimi-coding", modelId: "k3-256k" },
];

export function p2wModel(model: ModelRef) {
	return P2W_MODELS.find((choice) => choice.provider === model.provider && choice.modelId === model.modelId);
}

export function offeredModel(model: ModelRef): boolean {
	return (
		process.env.PI_MOBILE_PROFILE !== "p2w" || process.env.PI_MOBILE_FAKE === "1" || p2wModel(model) !== undefined
	);
}
