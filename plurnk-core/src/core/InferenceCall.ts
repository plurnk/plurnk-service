import { isDeepStrictEqual } from "node:util";
import type {
    ProviderRequestAccounting,
    ProviderRequestObserver,
} from "@plurnk/plurnk-contracts";
import { validateProviderRequestAccounting } from "@plurnk/plurnk-providers";
import type { Db } from "./Db.ts";
import { providerRequestSettlementParams } from "./provider-accounting.ts";

export class InferenceCallPersistenceError extends Error {
    constructor(message: string, cause: unknown) {
        super(message, { cause });
        this.name = "InferenceCallPersistenceError";
    }
}

export class ProviderAccountingIntegrityError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ProviderAccountingIntegrityError";
    }
}

// One concurrency-safe logical inference ledger. Provider adapters may open
// several ordered physical requests beneath it; each occurrence becomes
// durable before I/O and settles exactly once. {§tokenomics-provider-usage}
export default class InferenceCall {
    readonly id: number;
    readonly sequence: number;
    readonly #db: Db;
    #requestSequence = 0;
    readonly #observedRequests: ProviderRequestAccounting[] = [];

    protected constructor(db: Db, id: number, sequence: number) {
        this.#db = db;
        this.id = id;
        this.sequence = sequence;
    }

    get requestSequence(): number {
        return this.#requestSequence;
    }

    readonly observeRequest: ProviderRequestObserver = async (identity) => {
        if (identity.provider.length === 0 || identity.model.length === 0) {
            throw new TypeError("provider request identity requires non-empty provider and model names");
        }
        const sequence = ++this.#requestSequence;
        let row: { id: number } | undefined;
        try {
            row = await this.#db.engine_open_provider_request.get<{ id: number }>({
                inference_call_id: this.id,
                sequence,
                provider: identity.provider,
                model: identity.model,
            });
        } catch (cause) {
            throw new InferenceCallPersistenceError(
                `could not open provider request ${sequence} for inference call ${this.id}`,
                cause,
            );
        }
        if (row === undefined) {
            throw new InferenceCallPersistenceError(
                `provider request ${sequence} for inference call ${this.id} did not open`,
                new Error("INSERT RETURNING produced no row"),
            );
        }
        let settled = false;
        return async (value) => {
            if (settled) {
                throw new ProviderAccountingIntegrityError(
                    `provider request ${row.id} was settled more than once`,
                );
            }
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
                throw new InferenceCallPersistenceError(
                    `could not settle provider request ${row.id}`,
                    cause,
                );
            }
            settled = true;
            // Physical requests are identified and projected in issuance
            // order. Parallel embedding partitions may settle in any order,
            // so settlement chronology cannot define the accounting array.
            this.#observedRequests[sequence - 1] = accounting;
        };
    };

    assertAccounting(accounting: readonly ProviderRequestAccounting[]): void {
        const returned = accounting.map(validateProviderRequestAccounting);
        if (returned.length !== this.#requestSequence
            || !isDeepStrictEqual(returned, this.#observedRequests)) {
            throw new ProviderAccountingIntegrityError(
                `provider accounting for inference call ${this.id} does not match the cardinal requests observed by Core`,
            );
        }
    }
}
