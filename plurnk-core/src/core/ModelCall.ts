import type {
    ProviderAttempt,
    ProviderRequestCapacity,
} from "@plurnk/plurnk-providers";
import type { Db } from "./Db.ts";
import InferenceCall, {
    InferenceCallPersistenceError,
    ProviderAccountingIntegrityError,
} from "./InferenceCall.ts";
import type { SchemeResult } from "./results.ts";

export type ModelCallKind = "emission" | "bare";

export { InferenceCallPersistenceError as ModelCallPersistenceError, ProviderAccountingIntegrityError };

// One concurrency-safe logical model-call ledger. A provider may open several
// ordered physical requests beneath it; no mutable observer state is shared
// across sibling BARE calls. {§provider-request-accounting} {§bare-inference}
export default class ModelCall extends InferenceCall {
    readonly #db: Db;

    private constructor(db: Db, id: number, sequence: number) {
        super(db, id, sequence);
        this.#db = db;
    }

    static async open(
        db: Db,
        input: {
            turnId: number;
            kind: ModelCallKind;
            attributions: readonly string[];
            model: string;
        },
    ): Promise<ModelCall> {
        let row: { id: number; sequence: number } | undefined;
        try {
            row = await db.engine_open_model_call.get<{ id: number; sequence: number }>({
                turn_id: input.turnId,
                kind: input.kind,
                attributions: JSON.stringify(input.attributions),
                model: input.model,
            });
        } catch (cause) {
            throw new InferenceCallPersistenceError(
                `could not open ${input.kind} model call for turn ${input.turnId}`,
                cause,
            );
        }
        if (row === undefined) {
            throw new InferenceCallPersistenceError(
                `could not open ${input.kind} model call for turn ${input.turnId}`,
                new Error("INSERT RETURNING produced no row"),
            );
        }
        return new ModelCall(db, row.id, row.sequence);
    }

    async observeResponse(response: ProviderAttempt, failure: SchemeResult | null = null): Promise<void> {
        const { accounting: _accounting, capacity, ...evidence } = response;
        try {
            const result = await this.#db.engine_observe_model_call_response.run({
                id: this.id,
                response: JSON.stringify(evidence),
                failure: failure === null ? null : JSON.stringify(failure),
                capacity: JSON.stringify(capacity),
                finish_reason: response.assistant.finishReason,
                model: response.assistant.model,
            });
            if (result.changes !== 1) throw new Error(`model call ${this.id} was not pending`);
        } catch (cause) {
            throw new InferenceCallPersistenceError(
                `could not preserve response for model call ${this.id}`,
                cause,
            );
        }
    }

    async fail(failure: SchemeResult, capacity: ProviderRequestCapacity | null = null): Promise<void> {
        try {
            const result = await this.#db.engine_fail_model_call.run({
                id: this.id,
                failure: JSON.stringify(failure),
                capacity: capacity === null ? null : JSON.stringify(capacity),
            });
            if (result.changes !== 1) throw new Error(`model call ${this.id} was not pending`);
        } catch (cause) {
            throw new InferenceCallPersistenceError(
                `could not preserve failure for model call ${this.id}`,
                cause,
            );
        }
    }
}
