import type { ProblemDetails } from "@plurnk/plurnk-contracts";
import type { Db } from "./Db.ts";
import Results, { type SchemeResult } from "./results.ts";
import type { WriterTier } from "./scheme-types.ts";
import LogBody from "./LogBody.ts";

export interface RecordProblem {
    readonly workerId: number;
    readonly loopId: number;
    readonly turnId: number;
    readonly sequence: number;
    readonly origin: WriterTier;
    readonly source: string;
    readonly result: SchemeResult;
    readonly outcome?: string | null;
}

export interface MintedProblem {
    readonly id: number;
    readonly result: SchemeResult & { readonly problem: ProblemDetails };
}

// Owns durable actionless failures. Instrumentation may observe the resulting row,
// but it never creates, transforms, or substitutes for product failure truth.
export default class ProblemLog {
    #db: Db;
    #weighContent: (text: string) => number;

    constructor(db: Db, weigh: (text: string) => number) {
        this.#db = db;
        this.#weighContent = weigh;
    }

    async record(input: RecordProblem): Promise<MintedProblem> {
        const coordinate = await this.#db.engine_loop_turn_seqs.get<{
            loop_seq: number;
            turn_seq: number;
        }>({
            loop_id: input.loopId,
            turn_id: input.turnId,
        });
        if (coordinate === undefined) {
            throw new Error(`ProblemLog.record: no coordinate for loop=${input.loopId} turn=${input.turnId}`);
        }

        const result = structuredClone(Results.assert(input.result));
        if (!Results.isErrorStatus(result.status) || result.problem === undefined) {
            throw new TypeError("ProblemLog.record requires a failed operation result");
        }
        const failure = result as SchemeResult & { readonly problem: ProblemDetails };
        Results.attachInstance(
            failure,
            `log:///${coordinate.loop_seq}/${coordinate.turn_seq}/${input.sequence}/error`,
        );
        const rx = JSON.stringify(failure);
        const attrs = "{}";
        const row = await this.#db.engine_insert_log_entry.get<{ id: number }>({
            worker_id: input.workerId,
            loop_id: input.loopId,
            turn_id: input.turnId,
            sequence: input.sequence,
            origin: input.origin,
            source: input.source,
            model_call_id: null,
            op: "error",
            delimiter: "",
            signal: null,
            scheme: null,
            username: null,
            password: null,
            hostname: null,
            port: null,
            pathname: null,
            query: null,
            fragment: null,
            lineMarker: null,
            tx: "",
            mimetype_tx: "text/plain",
            rx,
            mimetype_rx: "application/json",
            status_rx: failure.status,
            weight: LogBody.weight({
                op: "error",
                attrs,
                tx: "",
                rx,
                mimetypeTx: "text/plain",
                mimetypeRx: "application/json",
            }, this.#weighContent),
            state: "failed",
            outcome: input.outcome ?? failure.problem.type,
            attrs,
        });
        if (row === undefined) throw new Error("ProblemLog.record: INSERT ... RETURNING produced no row");
        return { id: row.id, result: failure };
    }
}
