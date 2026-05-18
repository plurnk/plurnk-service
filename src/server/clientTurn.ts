// Helper for creating a turn inside a connection's client loop. Each
// client-origin RPC dispatch (op.*) creates one such turn with a synthetic
// packet matching the same shape as model turns but with empty content.

import type { Db, PrepMethod } from "../core/Db.ts";

const CLIENT_TURN_PACKET = JSON.stringify({
    tokens: 0,
    system: { tokens: 0, system_definition: "", persona: "", index: [], log: [] },
    user: {
        tokens: 0,
        prompt: "",
        telemetry: { budget: { used: 0, limit: 0, unit: "characters" }, errors: [] },
        system_requirements: "",
    },
    assistant: { tokens: 0, content: "", ops: [], reasoning: null },
    assistantRaw: null,
});

export const insertClientTurn = async (db: Db, loopId: number): Promise<number> => {
    const seqRow = await (db.client_turn_next_sequence as PrepMethod).get<{ next: number }>({ loop_id: loopId });
    if (seqRow === undefined) throw new Error("insertClientTurn: next-sequence query returned no row");
    const row = await (db.client_turn_insert as PrepMethod).get<{ id: number }>({
        loop_id: loopId, sequence: seqRow.next, packet: CLIENT_TURN_PACKET,
    });
    if (row === undefined) throw new Error("insertClientTurn: insert returned no row");
    return row.id;
};
