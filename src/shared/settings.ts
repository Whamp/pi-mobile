import type { AuthOperationOptions } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai/utils/typebox-helpers";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import { stripBom, stripJsonComments } from "./config-json.ts";
import { LockedFile } from "./locked-file.ts";

const integer = (minimum: number) => Type.Integer({ minimum });
const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const queueModes = ["all", "one-at-a-time"] as const;
const schema = Type.Object(
	{
		defaultModel: Type.Optional(
			Type.Object(
				{ provider: Type.String({ minLength: 1 }), modelId: Type.String({ minLength: 1 }) },
				{ additionalProperties: false },
			),
		),
		thinkingLevel: Type.Optional(StringEnum(thinkingLevels)),
		stream: Type.Optional(
			Type.Object(
				{
					transport: Type.Optional(StringEnum(["auto", "sse", "websocket"] as const)),
					timeoutMs: Type.Optional(integer(1)),
					maxRetries: Type.Optional(integer(0)),
					maxRetryDelayMs: Type.Optional(integer(0)),
					cacheRetention: Type.Optional(StringEnum(["none", "short", "long"] as const)),
				},
				{ additionalProperties: false },
			),
		),
		retry: Type.Optional(
			Type.Object(
				{
					enabled: Type.Optional(Type.Boolean()),
					maxRetries: Type.Optional(integer(0)),
					baseDelayMs: Type.Optional(integer(0)),
					maxAgentDelayMs: Type.Optional(integer(0)),
				},
				{ additionalProperties: false },
			),
		),
		compaction: Type.Optional(
			Type.Object(
				{
					enabled: Type.Optional(Type.Boolean()),
					reserveTokens: Type.Optional(integer(1)),
					keepRecentTokens: Type.Optional(integer(1)),
					backgroundTokens: Type.Optional(integer(0)),
				},
				{ additionalProperties: false },
			),
		),
		toolExecution: Type.Optional(StringEnum(["parallel", "sequential"] as const)),
		steeringMode: Type.Optional(StringEnum(queueModes)),
		followUpMode: Type.Optional(StringEnum(queueModes)),
	},
	{ additionalProperties: false },
);
const validator = Compile(schema);
export type MobileSettings = Static<typeof schema>;

export function validateSettings(value: unknown): MobileSettings {
	if (!validator.Check(value)) throw new Error("Invalid settings.json configuration");
	return structuredClone(value) as MobileSettings;
}
export function parseSettings(content: string): MobileSettings {
	let value: unknown;
	try {
		value = JSON.parse(stripJsonComments(stripBom(content)));
	} catch {
		throw new Error("Invalid settings.json syntax");
	}
	return validateSettings(value);
}
export async function saveSettings(path: string, value: unknown, options?: AuthOperationOptions): Promise<void> {
	const settings = validateSettings(value);
	await new LockedFile(path).withLockAsync(
		async () => ({
			result: undefined,
			next: JSON.stringify(settings, null, 2),
		}),
		options,
	);
}
