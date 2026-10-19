import { isRecord, isSafeInteger } from "@plurnk/plurnk-contracts";
import { chatMessageText } from "./types.ts";
import type { ChatMessage, PromptTokenMeasurement } from "./types.ts";

const KINDS: ReadonlySet<string> = new Set<PromptTokenMeasurement["kind"]>([
    "exact",
    "upper_bound",
    "estimate",
    "unavailable",
]);

export const assertPromptTokenMeasurement = (
    value: unknown,
    owner = "provider",
): PromptTokenMeasurement => {
    checkPromptTokenMeasurement(value, owner);
    return value;
};

const isKind = (value: unknown): value is PromptTokenMeasurement["kind"] => typeof value === "string" && KINDS.has(value);

// Every field a measurement names, by its kind, is checked here; the measurement is the value that passed.
function checkPromptTokenMeasurement(value: unknown, owner: string): asserts value is PromptTokenMeasurement {
    if (!isRecord(value)) {
        throw new TypeError(`${owner}: prompt token measurement must be an object`);
    }
    const candidate = value;
    const kind = candidate.kind;
    if (!isKind(kind)) {
        throw new TypeError(`${owner}: prompt token measurement has invalid kind ${JSON.stringify(candidate.kind)}`);
    }
    if (kind !== "unavailable"
        && (!isSafeInteger(candidate.tokens) || candidate.tokens < 0)) {
        throw new TypeError(`${owner}: prompt token measurement tokens must be a non-negative integer`);
    }
    if (typeof candidate.source !== "string" || candidate.source.length === 0) {
        throw new TypeError(`${owner}: prompt token measurement source must be a non-empty string`);
    }
    if ((kind === "estimate" || kind === "unavailable")
        && (typeof candidate.detail !== "string" || candidate.detail.length === 0)) {
        throw new TypeError(`${owner}: ${kind} prompt token measurement requires detail`);
    }
}

export const estimatePromptTokens = (
    messages: readonly ChatMessage[],
    detail = "chars/2 over message content; provider request framing is unknown",
): PromptTokenMeasurement => ({
    kind: "estimate",
    tokens: Math.ceil(messages.reduce((sum, message) => sum + chatMessageText(message).length, 0) / 2),
    source: "heuristic:chars2",
    detail,
});
