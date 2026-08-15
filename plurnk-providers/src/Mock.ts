// Mock provider — reference implementation + test fixture.
//
// Dual purpose: (a) plurnk-service intg suite uses it for deterministic
// engine tests; (b) worked example for sibling authors implementing the
// Provider contract. Production providers don't expose the `ops` escape
// hatch — that's an intg-only convenience.

import type { ChatMessage, FinishReason, GrammarEvidence, PromptTokenMeasurement, Provider, ProviderAssistant, ProviderCost, ProviderEncryptedReasoningItem, ProviderRequestAccounting, ProviderRequestCapacity, ProviderResponse, ProviderUsage } from "./types.ts";
import { resolveGenerationEnvelopeFromEnv } from "./env.ts";
import { validateProviderRequestAccounting } from "./accounting.ts";
import { ProviderError } from "./errors.ts";
import { assessRequestCapacity, effectiveInputCapacity, effectiveOutputBudget, effectiveReasoningBudget } from "./capacity.ts";

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
    #outputBudget: number | null;
    #reasoningBudget: number | null;
    #queue: MockResponse[];

    // {§provider-generation-envelope} Mock resolves the same generation
    // envelope as a real provider, but tolerates absent policy because it is
    // also the universal test fixture. No output budget means its context
    // window alone cannot determine an input capacity. Mock has no alias
    // identity, so it reads the bare knobs.
    constructor({ contextWindow, responses }: { contextWindow: number | null; responses: MockResponse[] }) {
        this.#contextWindow = contextWindow;
        const envelope = resolveGenerationEnvelopeFromEnv(process.env, contextWindow);
        this.#outputBudget = envelope.outputBudget;
        this.#reasoningBudget = envelope.reasoningBudget;
        this.#queue = [...responses];
    }

    get contextWindow(): number | null { return this.#contextWindow; }
    get maxInputTokens(): number | null { return null; }
    get maxOutputTokens(): number | null { return null; }
    get outputBudget(): number | null { return this.#outputBudget; }
    get reasoningBudget(): number | null { return this.#reasoningBudget; }
    get inputCapacity(): number | null {
        return effectiveInputCapacity({
            contextWindow: this.#contextWindow,
            maxInputTokens: this.maxInputTokens,
            outputBudget: this.#outputBudget,
        });
    }
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

    async assessRequestCapacity(
        messages: readonly ChatMessage[],
        maxOutputTokens?: number,
    ): Promise<ProviderRequestCapacity> {
        const outputBudget = effectiveOutputBudget({
            requested: maxOutputTokens,
            configured: this.#outputBudget,
            maxOutputTokens: null,
            contextWindow: this.#contextWindow,
        });
        const reasoningBudget = effectiveReasoningBudget({
            configured: this.#reasoningBudget,
            outputBudget,
        });
        return assessRequestCapacity({
            contextWindow: this.#contextWindow,
            maxInputTokens: null,
            maxOutputTokens: null,
            outputBudget,
            reasoningBudget,
            measurement: await this.countPromptTokens(messages),
        });
    }

    async generate({ messages, maxOutputTokens, signal, grammar, observeRequest }: MockGenerateArgs): Promise<MockReturnedResponse> {
        // Honor abort before consuming the queue — an aborted call makes no
        // "wire call" and must not exhaust a queued response
        // ({§provider-failure-normalization}).
        signal?.throwIfAborted();
        const capacity = await this.assessRequestCapacity(messages, maxOutputTokens);
        if (capacity.decision === "reject") {
            throw new ProviderError("mock", "capacity_exceeded", "Mock request exceeds its exact input capacity.", {
                capacity,
                extensions: { capacityStage: "preflight", capacity },
            });
        }
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
                { accounting: [accounting], capacity },
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
            capacity,
            ...(grammarEvidence !== undefined ? { grammarEvidence } : {}),
        };
    }

    get remaining(): number { return this.#queue.length; }
}

export { DEFAULT_USAGE as mockDefaultUsage };
