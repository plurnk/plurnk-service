import type { Db } from "./Db.ts";

export type JournalTurnRow = { id: number; sequence: number };

// {§packet-stored-shape} — an operation journal may need a Turn container
// without ever assembling a model request. Its packet is therefore NULL.
export default class JournalTurn {
    static async insert(db: Db, loopId: number): Promise<JournalTurnRow> {
        const sequence = await db.journal_turn_next_sequence.get<{ next: number }>({ loop_id: loopId });
        if (sequence === undefined) throw new Error("JournalTurn.insert: next-sequence query returned no row");
        const turn = await db.journal_turn_insert.get<JournalTurnRow>({ loop_id: loopId, sequence: sequence.next });
        if (turn === undefined) throw new Error("JournalTurn.insert: insert returned no row");
        return turn;
    }
}
