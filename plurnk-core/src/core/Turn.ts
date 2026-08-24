import type { Db } from "./Db.ts";
import type { WriterTier } from "./scheme-types.ts";

export type TurnProducer = WriterTier;
export type TurnKind = "inference" | "initialization" | "overflow" | "operation" | "maintenance";

export interface TurnRow {
    readonly id: number;
    readonly sequence: number;
}

export interface InferenceEvidence {
    readonly packet: string;
    readonly usageCurationBudget: number | null;
    readonly finishReason: string | null;
    readonly model: string;
    readonly meta: string;
}

// {§turn-record} — one lifecycle owner for every producer. A packet and its
// provider metadata are optional inference evidence, never the definition of a
// turn. Client, plugin, model, and `_plurnk` work all open and complete here.
export default class Turn {
    static async open(
        db: Db,
        args: { loopId: number; producer: TurnProducer; kind: TurnKind },
    ): Promise<TurnRow> {
        const turn = await db.turn_open.get<TurnRow>({
            loop_id: args.loopId,
            producer: args.producer,
            kind: args.kind,
        });
        if (turn === undefined) throw new Error("Turn.open: insert returned no row");
        return turn;
    }

    static async becomeOverflow(db: Db, id: number): Promise<void> {
        const turn = await db.turn_become_overflow.get<{ id: number }>({ id });
        if (turn === undefined) {
            throw new Error(`Turn.becomeOverflow: model inference turn ${id} cannot become overflow`);
        }
    }

    static async recordInference(db: Db, id: number, evidence: InferenceEvidence): Promise<void> {
        const turn = await db.turn_record_inference.get<{ id: number }>({
            id,
            packet: evidence.packet,
            usage_curation_budget: evidence.usageCurationBudget,
            finish_reason: evidence.finishReason,
            model: evidence.model,
            meta: evidence.meta,
        });
        if (turn === undefined) {
            throw new Error(`Turn.recordInference: turn ${id} is not an open model inference turn`);
        }
    }

    static async complete(db: Db, id: number, status: number): Promise<void> {
        const turn = await db.turn_complete.get<{ id: number }>({ id, status });
        if (turn === undefined) throw new Error(`Turn.complete: turn ${id} is not open`);
    }

    static async failOpen(db: Db, id: number): Promise<boolean> {
        return (await db.turn_fail_open.get<{ id: number }>({ id })) !== undefined;
    }
}
