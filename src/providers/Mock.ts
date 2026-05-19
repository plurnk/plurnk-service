import type { PlurnkStatement } from "@plurnk/plurnk-grammar";
import type { Provider, ProviderAssistant, ProviderUsage } from "../core/ProviderRegistry.ts";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

// Test-fixture input shape. usage/finishReason/model are optional — Mock
// fills defaults. `ops` is the test-fixture escape hatch consumed by
// Engine.#assembleAssistant when present (skips the parse roundtrip).
export type MockAssistant = {
    content: string;
    reasoning: string | null;
    usage?: ProviderUsage;
    finishReason?: string | null;
    model?: string;
    ops?: PlurnkStatement[];
};

export type MockResponse = {
    assistant: MockAssistant;
    assistantRaw?: unknown;
};

// Returned shape after Mock fills defaults — satisfies ProviderAssistant
// AND keeps the pre-parsed `ops` field visible for tests.
export type MockReturnedAssistant = ProviderAssistant & { ops?: PlurnkStatement[] };

const DEFAULT_USAGE: ProviderUsage = { prompt: 0, completion: 0, cached: 0, total: 0 };

export default class Mock implements Provider {
    #contextSize: number;
    #queue: MockResponse[];

    constructor({ contextSize, responses }: { contextSize: number; responses: MockResponse[] }) {
        this.#contextSize = contextSize;
        this.#queue = [...responses];
    }

    get contextSize(): number { return this.#contextSize; }
    get model(): string { return "mock"; }

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
