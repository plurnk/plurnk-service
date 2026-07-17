// Mock provider — reference implementation + test fixture.
//
// Dual purpose: (a) plurnk-service intg suite uses it for deterministic
// engine tests; (b) worked example for sibling authors implementing the
// Provider contract. Production providers don't expose the `ops` escape
// hatch — that's an intg-only convenience.

import type { ChatMessage, FinishReason, Provider, ProviderAssistant, ProviderUsage } from "./types.ts";
import { resolveEnvelopeFromEnv } from "./env.ts";

export type MockAssistant = {
    content: string;
    reasoning: string | null;
    // Partial — omitted fields fall back to DEFAULT_USAGE (e.g. reasoning: 0).
    usage?: Partial<ProviderUsage>;
    finishReason?: FinishReason;
    model?: string;
    // Pre-parsed ops — intg-only escape hatch. Typed `unknown[]` so the
    // framework carries NO @plurnk/plurnk-grammar dependency; plurnk-service
    // casts these to PlurnkStatement[] on its side. Production providers never
    // include this field.
    ops?: unknown[];
};

export type MockResponse = {
    assistant: MockAssistant;
    assistantRaw?: unknown;
};

// Returned shape: ProviderAssistant + pre-parsed ops visible for tests.
export type MockReturnedAssistant = ProviderAssistant & { ops?: unknown[] };

const DEFAULT_USAGE: ProviderUsage = { prompt: 0, completion: 0, reasoning: 0, cached: 0, total: 0 };

export default class Mock implements Provider {
    #contextWindow: number | null;
    #reasoningReserve: number | null;
    #completionReserve: number | null;
    #queue: MockResponse[];

    // #507: reserves resolve the SAME way a real provider's do — the TOLERANT env
    // read (the service's partition/budget suite sets PLURNK_PROVIDERS_*_RESERVE
    // and Mock reflects it, resolved against contextWindow). Tolerant, NOT the
    // fail-hard envelopeFromEnv: Mock is the universal fixture, constructed
    // without the reserves in most base tests, so absent env → null → the
    // consumer's no-cap path, and the ~100 `new Mock({ contextWindow, responses })`
    // sites stay untouched. Mock has no alias identity, so it reads the BARE knobs.
    constructor({ contextWindow, responses }: { contextWindow: number | null; responses: MockResponse[] }) {
        this.#contextWindow = contextWindow;
        const env = resolveEnvelopeFromEnv(process.env, contextWindow);
        this.#reasoningReserve = env.reasoningReserve;
        this.#completionReserve = env.completionReserve;
        this.#queue = [...responses];
    }

    get contextWindow(): number | null { return this.#contextWindow; }
    get reasoningReserve(): number | null { return this.#reasoningReserve; }
    get completionReserve(): number | null { return this.#completionReserve; }
    get model(): string { return "mock"; }

    // Heuristic tokenizer (chars/2 upper bound, matching the framework's
    // fallback). Mock is test-only; real provider siblings ship exact counts.
    countTokens(text: string): number {
        return text.length === 0 ? 0 : Math.ceil(text.length / 2);
    }

    // Mock is free.
    costFor(_usage: ProviderUsage): number { return 0; }

    async generate({ signal }: { messages: ChatMessage[]; workerId?: string; signal?: AbortSignal }): Promise<{ assistant: MockReturnedAssistant; assistantRaw: unknown }> {
        // Honor abort before consuming the queue — an aborted call makes no
        // "wire call" and must not exhaust a queued response (SPEC §10.8).
        signal?.throwIfAborted();
        const next = this.#queue.shift();
        if (next === undefined) throw new Error("Mock provider exhausted: no more queued responses");
        const a = next.assistant;
        const assistant: MockReturnedAssistant = {
            content: a.content,
            reasoning: a.reasoning,
            usage: { ...DEFAULT_USAGE, ...a.usage },
            finishReason: a.finishReason ?? "stop",
            model: a.model ?? "mock",
            ...(a.ops !== undefined ? { ops: a.ops } : {}),
        };
        return { assistant, assistantRaw: next.assistantRaw ?? null };
    }

    get remaining(): number { return this.#queue.length; }
}

export { DEFAULT_USAGE as mockDefaultUsage };
