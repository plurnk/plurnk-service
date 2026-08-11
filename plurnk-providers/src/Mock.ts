// Mock provider — reference implementation + test fixture.
//
// Dual purpose: (a) plurnk-service intg suite uses it for deterministic
// engine tests; (b) worked example for sibling authors implementing the
// Provider contract. Production providers don't expose the `ops` escape
// hatch — that's an intg-only convenience.

import type { ChatMessage, FinishReason, GrammarEvidence, PromptTokenMeasurement, Provider, ProviderAssistant, ProviderCost, ProviderEncryptedReasoningItem, ProviderRequestAccounting, ProviderResponse, ProviderUsage } from "./types.ts";
import { resolveEnvelopeFromEnv } from "./env.ts";
import { validateProviderRequestAccounting } from "./accounting.ts";
import { ProviderError } from "./errors.ts";

export type MockAssistant = {
    content: string;
    reasoning: string | null;
    finishReason?: FinishReason;
    model?: string;
    // Provider-normalized encrypted reasoning fixture.
    reasoningEncrypted?: ReadonlyArray<ProviderEncryptedReasoningItem>;
    // Pre-parsed ops — intg-only escape hatch. Typed `unknown[]` so the
    // framework carries no parser dependency; plurnk-service
    // casts these to PlurnkStatement[] on its side. Production providers never
    // include this field.
    ops?: unknown[];
};

export type MockResponse = {
    assistant: MockAssistant;
    assistantRaw?: unknown;
    // Partial — omitted fields fall back to the deliberate zero fixture.
    usage?: Partial<ProviderUsage>;
    cost?: ProviderCost;
    grammarEvidence?: GrammarEvidence;
};

// Returned shape: ProviderAssistant + pre-parsed ops visible for tests.
export type MockReturnedAssistant = ProviderAssistant & { ops?: unknown[] };
export type MockReturnedResponse = ProviderResponse & { assistant: MockReturnedAssistant };

const DEFAULT_USAGE: ProviderUsage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
};
type MockGenerateArgs = Omit<Parameters<Provider["generate"]>[0], "workerId"> & { workerId?: string };

export default class Mock implements Provider {
    #contextWindow: number | null;
    #reasoningReserve: number | null;
    #completionReserve: number | null;
    #queue: MockResponse[];

    // {§provider-generation-envelope} Reserves resolve the same way a real
    // provider's do — the tolerant env read (the service's partition/budget
    // suite sets PLURNK_PROVIDERS_*_RESERVE
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

    // Mock's deliberately simple vocabulary defines each two content code units
    // as one token and has no hidden request framing. This is exact for the mock,
    // unlike a production adapter applying the same arithmetic to an unknown model.
    async countPromptTokens(messages: readonly ChatMessage[]): Promise<PromptTokenMeasurement> {
        return {
            kind: "exact",
            tokens: messages.reduce((sum, { content }) => sum + Math.ceil(content.length / 2), 0),
            source: "mock:chars2",
        };
    }

    async generate({ signal, grammar, observeRequest }: MockGenerateArgs): Promise<MockReturnedResponse> {
        // Honor abort before consuming the queue — an aborted call makes no
        // "wire call" and must not exhaust a queued response
        // ({§provider-failure-normalization}).
        signal?.throwIfAborted();
        const settle = await observeRequest?.({ provider: "provider:mock", model: this.model });
        const next = this.#queue.shift();
        if (next === undefined) {
            const accounting = validateProviderRequestAccounting({
                provider: "provider:mock",
                model: this.model,
                outcome: "error",
                cost: { kind: "unknown", reason: "mock provider exhausted before producing a response" },
            });
            await settle?.(accounting);
            throw new ProviderError(
                "mock",
                "invalid_response",
                "Mock provider exhausted: no more queued responses",
                { accounting: [accounting] },
            );
        }
        const a = next.assistant;
        const usage: ProviderUsage = {
            ...DEFAULT_USAGE,
            ...next.usage,
        };
        const requestAccounting: ProviderRequestAccounting = validateProviderRequestAccounting({
            provider: "provider:mock",
            model: a.model ?? this.model,
            outcome: "response",
            usage,
            cost: next.cost ?? {
                kind: "estimated",
                amount: { amount: "0", currency: "USD" },
                source: "mock provider fixture",
            },
        });
        await settle?.(requestAccounting);
        const assistant: MockReturnedAssistant = {
            content: a.content,
            reasoning: a.reasoning,
            ...(a.reasoningEncrypted !== undefined ? { reasoningEncrypted: a.reasoningEncrypted } : {}),
            finishReason: a.finishReason ?? "stop",
            model: a.model ?? "mock",
            ...(a.ops !== undefined ? { ops: a.ops } : {}),
        };
        const grammarEvidence = next.grammarEvidence
            ?? (grammar === undefined
                ? undefined
                : { input: assistant.content, contentStart: 0, transported: true });
        return {
            assistant,
            assistantRaw: next.assistantRaw ?? null,
            accounting: [requestAccounting],
            ...(grammarEvidence !== undefined ? { grammarEvidence } : {}),
        };
    }

    get remaining(): number { return this.#queue.length; }
}

export { DEFAULT_USAGE as mockDefaultUsage };
