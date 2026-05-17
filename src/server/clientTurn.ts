// Helper for creating a turn inside a connection's client loop. Each
// client-origin RPC dispatch (op.*) creates one such turn with a synthetic
// packet matching the same shape as model turns but with empty content.

import type { DatabaseSync } from "node:sqlite";

const CLIENT_TURN_PACKET = JSON.stringify({
    tokens: 0,
    system: { tokens: 0, system_definition: "", persona: "", index: [], log: [] },
    user: { tokens: 0, prompt: "", turn: "", system_requirements: "" },
    assistant: { tokens: 0, content: "", ops: [], reasoning: null },
    assistantRaw: null,
});

export const insertClientTurn = (db: DatabaseSync, loopId: number): number => {
    const seq = (db
        .prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM turns WHERE loop_id = ?")
        .get(loopId) as { next: number }).next;
    const row = db
        .prepare("INSERT INTO turns (loop_id, sequence, status, packet) VALUES (?, ?, 200, ?) RETURNING id")
        .get(loopId, seq, CLIENT_TURN_PACKET) as { id: number };
    return row.id;
};
