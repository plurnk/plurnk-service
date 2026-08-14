import { isDeepStrictEqual } from "node:util";
import type {
    ProviderAttempt,
    ProviderRequestAccounting,
    ProviderRequestObserver,
} from "@plurnk/plurnk-providers";
import { validateProviderRequestAccounting } from "@plurnk/plurnk-providers";
import type { Db } from "./Db.ts";
import {
    providerRequestSettlementParams,
} from "./provider-accounting.ts";
import type { SchemeResult } from "./results.ts";

export type ModelCallKind = "emission" | "bare";

export class ModelCallPersistenceError extends Error {
    constructor(message: string, cause: unknown) {
        super(message, { cause });
        this.name = "ModelCallPersistenceError";
    }
}

export class ProviderAccountingIntegrityError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ProviderAccountingIntegrityError";
    }
}

// One concurrency-safe logical model-call ledger. A provider may open several
// ordered physical requests beneath it; no mutable observer state is shared
// across sibling BARE calls. {§provider-request-accounting} {§bare-inference}
export default class ModelCall {
    readonly id: number;
    readonly #db: Db;
    #requestSequence = 0;
    readonly #observedRequests: ProviderRequestAccounting[] = [];

    private constructor(db: Db, id: number) {
        this.#db = db;
        this.id = id;
    }

    static async open(
        db: Db,
        input: {
            turnId: number;
            sequence: number;
            kind: ModelCallKind;
            attributions: readonly string[];
            model: string;
        },
    ): Promise<ModelCall> {
        let row: { id: number } | undefined;
        try {
            row = await db.engine_open_model_call.get<{ id: number }>({
                turn_id: input.turnId,
                sequence: input.sequence,
                kind: input.kind,
                attributions: JSON.stringify(input.attributions),
                model: input.model,
            });
        } catch (cause) {
            throw new ModelCallPersistenceError(
                `could not open ${input.kind} model call ${input.sequence} for turn ${input.turnId}`,
                cause,
            );
        }
        if (row === undefined) {
            throw new ModelCallPersistenceError(
                `could not open ${input.kind} model call ${input.sequence} for turn ${input.turnId}`,
                new Error("INSERT RETURNING produced no row"),
            );
        }
        return new ModelCall(db, row.id);
    }

    readonly observeRequest: ProviderRequestObserver = async (identity) => {
        if (identity.provider.length === 0 || identity.model.length === 0) {
            throw new TypeError("provider request identity requires non-empty provider and model names");
        }
        const sequence = ++this.#requestSequence;
        let row: { id: number } | undefined;
        try {
            row = await this.#db.engine_open_provider_request.get<{ id: number }>({
                model_call_id: this.id,
                sequence,
                provider: identity.provider,
                model: identity.model,
            });
        } catch (cause) {
            throw new ModelCallPersistenceError(
                `could not open provider request ${sequence} for model call ${this.id}`,
                cause,
            );
        }
        if (row === undefined) {
            throw new ModelCallPersistenceError(
                `provider request ${sequence} for model call ${this.id} did not open`,
                new Error("INSERT RETURNING produced no row"),
            );
        }
        let settled = false;
        return async (value) => {
            if (settled) throw new ProviderAccountingIntegrityError(`provider request ${row.id} was settled more than once`);
            const accounting = validateProviderRequestAccounting(value);
            if (accounting.provider !== identity.provider || accounting.model !== identity.model) {
                throw new ProviderAccountingIntegrityError(
                    `provider request ${row.id} settlement changed its durable identity`,
                );
            }
            try {
                const result = await this.#db.engine_settle_provider_request.run(
                    providerRequestSettlementParams(row.id, accounting),
                );
                if (result.changes !== 1) {
                    throw new Error(`provider request ${row.id} was not pending at settlement`);
                }
            } catch (cause) {
                throw new ModelCallPersistenceError(
                    `could not settle provider request ${row.id}`,
                    cause,
                );
            }
            settled = true;
            this.#observedRequests.push(accounting);
        };
    };

    assertAccounting(accounting: readonly ProviderRequestAccounting[]): void {
        const returned = accounting.map(validateProviderRequestAccounting);
        if (!isDeepStrictEqual(returned, this.#observedRequests)) {
            throw new ProviderAccountingIntegrityError(
                `provider accounting for model call ${this.id} does not match the cardinal requests observed by Core`,
            );
        }
    }

    async observeResponse(response: ProviderAttempt, failure: SchemeResult | null = null): Promise<void> {
        const { accounting: _accounting, ...evidence } = response;
        try {
            const result = await this.#db.engine_observe_model_call_response.run({
                id: this.id,
                response: JSON.stringify(evidence),
                failure: failure === null ? null : JSON.stringify(failure),
                finish_reason: response.assistant.finishReason,
                model: response.assistant.model,
            });
            if (result.changes !== 1) throw new Error(`model call ${this.id} was not pending`);
        } catch (cause) {
            throw new ModelCallPersistenceError(
                `could not preserve response for model call ${this.id}`,
                cause,
            );
        }
    }

    async fail(failure: SchemeResult): Promise<void> {
        try {
            const result = await this.#db.engine_fail_model_call.run({
                id: this.id,
                failure: JSON.stringify(failure),
            });
            if (result.changes !== 1) throw new Error(`model call ${this.id} was not pending`);
        } catch (cause) {
            throw new ModelCallPersistenceError(
                `could not preserve failure for model call ${this.id}`,
                cause,
            );
        }
    }
}
