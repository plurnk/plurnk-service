// Mock provider — reference implementation + test fixture.
//
// Dual purpose: (a) plurnk-service intg suite uses it for deterministic
// engine tests; (b) worked example for sibling authors implementing the
// Provider contract. Production providers don't expose the `ops` escape
// hatch — that's an intg-only convenience.

import type { PlurnkStatement } from "@plurnk/plurnk-grammar";
import type { ChatMessage, Provider, ProviderAssistant, ProviderUsage } from "./types.ts";

export type MockAssistant = {
    content: string;
    reasoning: string | null;
    usage?: ProviderUsage;
    finishReason?: string | null;
    model?: string;
    // Pre-parsed ops — intg-only escape hatch. Production providers
    // never include this field.
    ops?: PlurnkStatement[];
};

export type MockResponse = {
    assistant: MockAssistant;
    assistantRaw?: unknown;
};

// Returned shape: ProviderAssistant + pre-parsed ops visible for tests.
export type MockReturnedAssistant = ProviderAssistant & { ops?: PlurnkStatement[] };

const DEFAULT_USAGE: ProviderUsage = { prompt: 0, completion: 0, cached: 0, total: 0 };

export default class Mock implements Provider {
    #contextSize: number | null;
    #queue: MockResponse[];

    constructor({ contextSize, responses }: { contextSize: number | null; responses: MockResponse[] }) {
        this.#contextSize = contextSize;
        this.#queue = [...responses];
    }

    get contextSize(): number | null { return this.#contextSize; }
    get model(): string { return "mock"; }

    // Heuristic tokenizer. Mock is test-only; real provider siblings ship
    // family-specific tokenizers.
    countTokens(text: string): number {
        return text.length === 0 ? 0 : Math.ceil(text.length / 4);
    }

    // Mock is free.
    costFor(_usage: ProviderUsage): number { return 0; }

    async generate(_: { messages: ChatMessage[]; signal?: AbortSignal }): Promise<{ assistant: MockReturnedAssistant; assistantRaw: unknown }> {
        const next = this.#queue.shift();
        if (next === undefined) throw new Error("Mock provider exhausted: no more queued responses");
        const a = next.assistant;
        const assistant: MockReturnedAssistant = {
            content: a.content,
            reasoning: a.reasoning,
            usage: a.usage ?? DEFAULT_USAGE,
            finishReason: a.finishReason ?? "stop",
            model: a.model ?? "mock",
            ...(a.ops !== undefined ? { ops: a.ops } : {}),
        };
        return { assistant, assistantRaw: next.assistantRaw ?? null };
    }

    get remaining(): number { return this.#queue.length; }
}

export { DEFAULT_USAGE as mockDefaultUsage };
