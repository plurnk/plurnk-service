import type { Db } from "./Db.ts";
import type { WriterTier } from "./scheme-types.ts";

export type TurnProducer = WriterTier;
export type TurnKind = "inference" | "initialization" | "operation" | "maintenance";

export interface TurnRow {
    readonly id: number;
    readonly sequence: number;
}

export interface InferenceEvidence {
    readonly packet: string;
    // {§packet-items} — the sections as StoredPacket.sections renders them for the write view.
    readonly sections: string;
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

    // {§packet-items} — one statement through the turn_inference_evidence view: the bag, the
    // sections as items, and the provider metadata land together, or the view's trigger refuses.
    static async recordInference(db: Db, id: number, evidence: InferenceEvidence): Promise<void> {
        await db.turn_record_inference.run({
            turn_id: id,
            packet: evidence.packet,
            sections: evidence.sections,
            usage_curation_budget: evidence.usageCurationBudget,
            finish_reason: evidence.finishReason,
            model: evidence.model,
            meta: evidence.meta,
        });
    }

    static async recordSource(db: Db, turnId: number, kind: "ops" | "reasoning", content: string, options: {
        modelCallId?: number | null;
    } = {}): Promise<void> {
        const row = await db.turn_source_record.get<{ turn_id: number }>({
            turn_id: turnId, kind, content,
            model_call_id: options.modelCallId ?? null,
        });
        if (row === undefined) throw new Error(`Turn.recordSource: ${kind} requires an open turn and its own settled inference evidence`);
    }

    static async complete(db: Db, id: number, status: number): Promise<void> {
        const turn = await db.turn_complete.get<{ id: number }>({ id, status });
        if (turn === undefined) throw new Error(`Turn.complete: turn ${id} is not open`);
    }

    static async failOpen(db: Db, id: number): Promise<boolean> {
        return (await db.turn_fail_open.get<{ id: number }>({ id })) !== undefined;
    }
}
