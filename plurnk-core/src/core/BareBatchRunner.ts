import type { BareStatement } from "@plurnk/plurnk-contracts";
import { type PluginAttributionContext } from "@plurnk/plurnk-meta";
import type { Db } from "./Db.ts";
import { randomUUID } from "node:crypto";
import Results, { type SchemeResult } from "./results.ts";
import { observed } from "../observe/spans.ts";
import { genAiRequestName, genAiRequestOptions, settleGenAiResponse } from "../observe/genai.ts";
import { PROVIDER_CALLS, recordCounter } from "../observe/metrics.ts";
import ModelCall, { ModelCallPersistenceError, ProviderAccountingIntegrityError } from "./ModelCall.ts";
import type { Provider } from "@plurnk/plurnk-providers";
import { ProviderError } from "@plurnk/plurnk-providers";
import ProviderInstantiate from "./ProviderInstantiate.ts";
import type { BareBatchResult } from "./TurnRunner.ts";
import type NoticeChannel from "./NoticeChannel.ts";
import ProviderRecovery from "./ProviderRecovery.ts";
import { setTimeout as delay } from "node:timers/promises";

type Notice = Parameters<NoticeChannel["push"]>[3];

export default class BareBatchRunner {
    readonly #db: Db;
    readonly #providerAttributions: (provider: Provider, context: PluginAttributionContext) => string[];
    readonly #providerFailure: (error: unknown, signal: AbortSignal | undefined) => SchemeResult;

    constructor({ db, providerAttributions, providerFailure }: {
        db: Db;
        providerAttributions: (provider: Provider, context: PluginAttributionContext) => string[];
        providerFailure: (error: unknown, signal: AbortSignal | undefined) => SchemeResult;
    }) {
        this.#db = db;
        this.#providerAttributions = providerAttributions;
        this.#providerFailure = providerFailure;
    }

    async runBareBatch({
        statements,
        preparePrompt,
        provider,
        turnId,
        workspaceId,
        workerId,
        loopSequence,
        turnSequence,
        signal,
        notice,
    }: {
        statements: readonly BareStatement[];
        preparePrompt: (statement: BareStatement) => Promise<{ prompt: string } | { result: SchemeResult }>;
        provider: Provider;
        turnId: number;
        workspaceId: number;
        workerId: number;
        loopSequence: number;
        turnSequence: number;
        signal: AbortSignal | undefined;
        notice: (notice: Notice) => void;
    }): Promise<BareBatchResult[]> {
        const inputs: Array<{ statement: BareStatement } & ({ prompt: string } | { result: SchemeResult })> = [];
        for (const statement of statements) {
            signal?.throwIfAborted();
            inputs.push({ statement, ...await preparePrompt(statement) });
        }
        signal?.throwIfAborted();
        const prepared: Array<{
            statement: BareStatement;
        } & ({ result: SchemeResult } | {
            prompt: string;
            modelCall: ModelCall;
            providerWorkerId: string;
        })> = [];
        for (const input of inputs) {
            if ("result" in input) {
                prepared.push(input);
                continue;
            }
            const { statement, prompt } = input;
            const providerWorkerId = randomUUID();
            const attributionContext: PluginAttributionContext = Object.freeze({
                workspaceId: String(workspaceId),
                workerId: providerWorkerId,
                loop: loopSequence,
                turn: turnSequence,
                attempt: 1,
            });
            const attributions = this.#providerAttributions(provider, attributionContext);
            const modelCall = await ModelCall.open(this.#db, {
                turnId,
                kind: "bare",
                attributions,
                model: provider.model,
            });
            prepared.push({ statement, prompt, modelCall, providerWorkerId });
        }

        const settlements = await Promise.allSettled(prepared.map(async (item) => {
            if ("result" in item) return { ...item, modelCallId: null };
            const { statement, prompt, providerWorkerId } = item;
            let { modelCall } = item;
            // {§provider-recovery} — an isolated call takes the loop's recovery: each re-issue is its
            // own model call on the ledger, under the same window and backoff as the loop's inference.
            const recovery = { budget: ProviderRecovery.budget(), backoff: ProviderRecovery.backoff(), startedAt: null as number | null, failures: 0 };
            for (let attempt = 1; ; attempt += 1) {
                try {
                    signal?.throwIfAborted();
                    const call = modelCall;
                    const response = await observed(
                        genAiRequestName(provider.model),
                        { model: provider.model, attempt, kind: "bare" },
                        async (span) => {
                            try {
                                const generated = await provider.generate({
                                    messages: [{ role: "user", content: prompt }],
                                    workerId: providerWorkerId,
                                    workspaceId: String(workspaceId),
                                    signal,
                                    observeRequest: call.observeRequest,
                                    callKind: "bare",
                                });
                                call.assertAccounting(generated.accounting);
                                recordCounter(PROVIDER_CALLS, {
                                    model: provider.model,
                                    attempt,
                                    status: "resolved",
                                });
                                span.setAttribute("status", "resolved");
                                settleGenAiResponse(span, generated);
                                return generated;
                            } catch (error) {
                                if (error instanceof ProviderError) {
                                    call.assertAccounting(error.accounting);
                                }
                                throw error;
                            }
                        },
                        genAiRequestOptions(
                            ProviderInstantiate.providerIdOf(provider) ?? "other",
                            provider.model,
                        ),
                    );
                    await modelCall.observeResponse(response);
                    if (recovery.failures > 0) {
                        notice({ source: "engine:provider", kind: "provider_recovered", level: "info", message: `The isolated call answered after ${recovery.failures} re-issued call(s).` });
                    }
                    return {
                        statement,
                        modelCallId: modelCall.id,
                        result: Results.assert({
                            status: 200,
                            content: response.assistant.content,
                            mimetype: "text/plain",
                        }),
                    };
                } catch (error) {
                    if (error instanceof ModelCallPersistenceError || error instanceof ProviderAccountingIntegrityError) {
                        throw error;
                    }
                    const failure = this.#providerFailure(error, signal);
                    if (error instanceof ProviderError && error.attempt !== undefined) {
                        await modelCall.observeResponse(error.attempt, failure);
                    } else {
                        await modelCall.fail(failure);
                    }
                    const recoverable = error instanceof ProviderError && ProviderRecovery.RECOVERABLE.has(error.kind) && signal?.aborted !== true;
                    if (!recoverable) return { statement, modelCallId: modelCall.id, result: failure };
                    recovery.startedAt ??= Date.now();
                    const elapsed = Date.now() - recovery.startedAt;
                    if (elapsed >= recovery.budget) return { statement, modelCallId: modelCall.id, result: failure };
                    recovery.failures += 1;
                    const wait = ProviderRecovery.wait(recovery.backoff, recovery.failures);
                    notice({
                        source: "engine:provider",
                        kind: "provider_unavailable",
                        level: "warn",
                        message: `${failure.problem?.title ?? "Provider failure"}: re-issuing the isolated call in ${Math.round(wait / 1000)}s (${Math.round(elapsed / 1000)}s of the ${Math.round(recovery.budget / 1000)}s recovery window used).`,
                    });
                    // An abort during the wait re-enters generate, which refuses on the aborted signal.
                    await delay(wait, undefined, { signal }).catch(() => undefined);
                    const attributions = this.#providerAttributions(provider, Object.freeze({
                        workspaceId: String(workspaceId),
                        workerId: providerWorkerId,
                        loop: loopSequence,
                        turn: turnSequence,
                        attempt: attempt + 1,
                    }));
                    modelCall = await ModelCall.open(this.#db, { turnId, kind: "bare", attributions, model: provider.model });
                }
            }
        }));

        const internalFailure = settlements.find(
            (settlement): settlement is PromiseRejectedResult => settlement.status === "rejected",
        );
        if (internalFailure !== undefined) throw internalFailure.reason;
        signal?.throwIfAborted();
        return settlements.map((settlement) => (settlement as PromiseFulfilledResult<BareBatchResult>).value);
    }

}
