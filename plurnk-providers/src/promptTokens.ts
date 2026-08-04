import type { ChatMessage, PromptTokenMeasurement } from "./types.ts";

const KINDS = new Set<PromptTokenMeasurement["kind"]>([
    "exact",
    "upper_bound",
    "estimate",
]);

export const assertPromptTokenMeasurement = (
    value: unknown,
    owner = "provider",
): PromptTokenMeasurement => {
    if (typeof value !== "object" || value === null) {
        throw new TypeError(`${owner}: prompt token measurement must be an object`);
    }
    const candidate = value as Partial<PromptTokenMeasurement>;
    if (!KINDS.has(candidate.kind as PromptTokenMeasurement["kind"])) {
        throw new TypeError(`${owner}: prompt token measurement has invalid kind ${JSON.stringify(candidate.kind)}`);
    }
    if (!Number.isInteger(candidate.tokens) || candidate.tokens! < 0) {
        throw new TypeError(`${owner}: prompt token measurement tokens must be a non-negative integer`);
    }
    if (typeof candidate.source !== "string" || candidate.source.length === 0) {
        throw new TypeError(`${owner}: prompt token measurement source must be a non-empty string`);
    }
    if (candidate.kind === "estimate"
        && (typeof candidate.detail !== "string" || candidate.detail.length === 0)) {
        throw new TypeError(`${owner}: estimated prompt token measurement requires detail`);
    }
    return value as PromptTokenMeasurement;
};

export const estimatePromptTokens = (
    messages: readonly ChatMessage[],
    detail = "chars/2 over message content; provider request framing is unknown",
): PromptTokenMeasurement => ({
    kind: "estimate",
    tokens: Math.ceil(messages.reduce((sum, { content }) => sum + content.length, 0) / 2),
    source: "heuristic:chars2",
    detail,
});
