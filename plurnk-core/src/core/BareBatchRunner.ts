import type { BareStatement } from "@plurnk/plurnk-contracts";
import { type PluginAttributionContext } from "@plurnk/plurnk-meta";
import type { Db } from "./Db.ts";
import { randomUUID } from "node:crypto";
import Results, { type SchemeResult } from "./results.ts";
import { observed } from "../observe/spans.ts";
import { GEN_AI_REQUEST_SPAN, genAiRequestOptions, settleGenAiResponse } from "../observe/genai.ts";
import { PROVIDER_CALLS, recordCounter } from "../observe/metrics.ts";
import ModelCall, { ModelCallPersistenceError, ProviderAccountingIntegrityError } from "./ModelCall.ts";
import type { Provider } from "@plurnk/plurnk-providers";
import { ProviderError } from "@plurnk/plurnk-providers";
import ProviderInstantiate from "./ProviderInstantiate.ts";
import type { BareBatchResult } from "./TurnRunner.ts";

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
        primaryWorkerId,
        loopSequence,
        turnSequence,
        signal,
    }: {
        statements: readonly BareStatement[];
        preparePrompt: (statement: BareStatement) => Promise<{ prompt: string } | { result: SchemeResult }>;
        provider: Provider;
        turnId: number;
        workspaceId: number;
        workerId: number;
        primaryWorkerId: string;
        loopSequence: number;
        turnSequence: number;
        signal: AbortSignal | undefined;
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
            attributions: string[];
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
                primaryWorkerId,
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
            prepared.push({ statement, prompt, modelCall, attributions, providerWorkerId });
        }

        const settlements = await Promise.allSettled(prepared.map(async (item) => {
            if ("result" in item) return { ...item, modelCallId: null };
            const { statement, prompt, modelCall, attributions, providerWorkerId } = item;
            try {
                signal?.throwIfAborted();
                const response = await observed(
                    GEN_AI_REQUEST_SPAN,
                    { model: provider.model, attempt: 1, kind: "bare" },
                    async (span) => {
                        try {
                            const generated = await provider.generate({
                                messages: [{ role: "user", content: prompt }],
                                workerId: providerWorkerId,
                                primaryWorkerId,
                                signal,
                                attributions: attributions.length > 0 ? attributions : undefined,
                                workspaceId: String(workspaceId),
                                loop: loopSequence,
                                turn: turnSequence,
                                observeRequest: modelCall.observeRequest,
                                callKind: "bare",
                            });
                            modelCall.assertAccounting(generated.accounting);
                            recordCounter(PROVIDER_CALLS, {
                                model: provider.model,
                                attempt: 1,
                                status: "resolved",
                            });
                            span.setAttribute("status", "resolved");
                            settleGenAiResponse(span, generated);
                            return generated;
                        } catch (error) {
                            if (error instanceof ProviderError) {
                                modelCall.assertAccounting(error.accounting);
                            }
                            throw error;
                        }
                    },
                    genAiRequestOptions(
                        ProviderInstantiate.aliasOf(provider) ?? "plurnk",
                        provider.model,
                    ),
                );
                await modelCall.observeResponse(response);
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
                return { statement, modelCallId: modelCall.id, result: failure };
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
