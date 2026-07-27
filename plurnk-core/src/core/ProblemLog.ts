import type { ProblemDetails } from "@plurnk/plurnk-grammar";
import type { Db } from "./Db.ts";
import Results, { type SchemeResult } from "./results.ts";
import type { WriterTier } from "./scheme-types.ts";

export interface MintProblem {
    readonly workerId: number;
    readonly loopId: number;
    readonly turnId: number;
    readonly sequence: number;
    readonly origin: WriterTier;
    readonly source: string;
    readonly owner: string;
    readonly code: string;
    readonly status: number;
    readonly detail: string;
    readonly outcome?: string | null;
    readonly extensions?: Readonly<Record<string, unknown>>;
}

export interface MintedProblem {
    readonly id: number;
    readonly result: SchemeResult & { readonly problem: ProblemDetails };
}

// Owns durable actionless failures. Telemetry may observe the resulting row,
// but it never creates, transforms, or substitutes for product failure truth.
export default class ProblemLog {
    #db: Db;

    constructor(db: Db) {
        this.#db = db;
    }

    async mint(input: MintProblem): Promise<MintedProblem> {
        const coordinate = await this.#db.engine_loop_turn_seqs.get<{
            loop_seq: number;
            turn_seq: number;
        }>({
            loop_id: input.loopId,
            turn_id: input.turnId,
        });
        if (coordinate === undefined) {
            throw new Error(`ProblemLog.mint: no coordinate for loop=${input.loopId} turn=${input.turnId}`);
        }

        const result = Results.failure(
            input.owner,
            input.code,
            input.status,
            input.detail,
            {},
            input.extensions,
        ) as SchemeResult & { readonly problem: ProblemDetails };
        Results.attachInstance(
            result,
            `log:///${coordinate.loop_seq}/${coordinate.turn_seq}/${input.sequence}/error`,
        );
        const rx = JSON.stringify(result);
        const row = await this.#db.engine_insert_log_entry.get<{ id: number }>({
            worker_id: input.workerId,
            loop_id: input.loopId,
            turn_id: input.turnId,
            sequence: input.sequence,
            origin: input.origin,
            source: input.source,
            op: "error",
            suffix: "",
            signal: null,
            scheme: null,
            username: null,
            password: null,
            hostname: null,
            port: null,
            pathname: null,
            params: null,
            fragment: null,
            lineMarker: null,
            tx: "",
            mimetype_tx: "text/plain",
            rx,
            mimetype_rx: "application/json",
            status_rx: input.status,
            tokens: 0,
            state: "failed",
            outcome: input.outcome ?? input.code,
            attrs: "{}",
        });
        if (row === undefined) throw new Error("ProblemLog.mint: INSERT ... RETURNING produced no row");
        return { id: row.id, result };
    }
}
