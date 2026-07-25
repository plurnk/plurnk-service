// Helper for creating an ordered statement turn inside a client action's
// journal segment, with a synthetic packet matching the model-turn shape.

import type { Db, PrepMethod } from "../core/Db.ts";

export default class ClientTurn {
    static #CLIENT_TURN_PACKET = JSON.stringify({
        tokens: 0,
        sections: [],
        assistant: { tokens: 0, content: "", ops: [], reasoning: null },
        assistantRaw: null,
    });

    static async insertClientTurn(db: Db, loopId: number): Promise<number> {
        const seqRow = await (db.client_turn_next_sequence as PrepMethod).get<{ next: number }>({ loop_id: loopId });
        if (seqRow === undefined) throw new Error("insertClientTurn: next-sequence query returned no row");
        const row = await (db.client_turn_insert as PrepMethod).get<{ id: number }>({
            loop_id: loopId, sequence: seqRow.next, packet: ClientTurn.#CLIENT_TURN_PACKET,
        });
        if (row === undefined) throw new Error("insertClientTurn: insert returned no row");
        return row.id;
    }
}
