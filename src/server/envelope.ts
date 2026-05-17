// Envelope lifecycle helpers for client connections. SPEC §13.7.
//
// Every connected client gets a (session, run, client-loop) envelope. Either
// the client picks the session explicitly (session.create / session.attach)
// or the daemon auto-creates one on first requiresInit RPC. In both cases
// the daemon opens a NEW run within the session and a NEW client loop within
// that run; the client loop closes on disconnect.

import type { DatabaseSync } from "node:sqlite";

export interface SessionRow {
    id: number;
    name: string;
    created_at: string;
    cost_pico: number;
}

export interface ClientEnvelope {
    sessionId: number;
    sessionName: string;
    runId: number;
    clientLoopId: number;
}

// Generates a unique session name. Prefix is "auto" for daemon-driven
// creation and "session" for explicit session.create with no name.
export const generateSessionName = (prefix: string): string => {
    const ts = Math.floor(Date.now() / 1000);
    const rand = Math.floor(Math.random() * 0xFFFFFF).toString(36).padStart(4, "0");
    return `${prefix}-${ts}-${rand}`;
};

// Create a new session + new run + new client loop. Used by both explicit
// session.create and the auto-create-on-first-requiresInit path.
export const createClientEnvelope = (db: DatabaseSync, opts: { name?: string; prefix?: string } = {}): ClientEnvelope => {
    const name = opts.name ?? generateSessionName(opts.prefix ?? "session");
    const session = db
        .prepare("INSERT INTO sessions (name) VALUES (?) RETURNING id, name")
        .get(name) as { id: number; name: string };
    const run = db
        .prepare("INSERT INTO runs (session_id) VALUES (?) RETURNING id")
        .get(session.id) as { id: number };
    const loop = db
        .prepare("INSERT INTO loops (run_id, sequence, status, prompt) VALUES (?, 1, 102, '') RETURNING id")
        .get(run.id) as { id: number };
    return { sessionId: session.id, sessionName: session.name, runId: run.id, clientLoopId: loop.id };
};

// Attach to an existing session: new run + new client loop. Each connection
// gets its own run within the attached session.
export const attachToSession = (db: DatabaseSync, sessionId: number): ClientEnvelope => {
    const session = db
        .prepare("SELECT id, name FROM sessions WHERE id = ?")
        .get(sessionId) as { id: number; name: string } | undefined;
    if (session === undefined) throw new Error(`session ${sessionId} not found`);
    const run = db
        .prepare("INSERT INTO runs (session_id) VALUES (?) RETURNING id")
        .get(session.id) as { id: number };
    const loop = db
        .prepare("INSERT INTO loops (run_id, sequence, status, prompt) VALUES (?, 1, 102, '') RETURNING id")
        .get(run.id) as { id: number };
    return { sessionId: session.id, sessionName: session.name, runId: run.id, clientLoopId: loop.id };
};

// Close a client loop on disconnect. 200 = clean disconnect; 499 = abrupt.
// Only transitions from 102 (active) — if already terminal, no-op.
export const closeClientLoop = (db: DatabaseSync, loopId: number, status: 200 | 499): void => {
    db.prepare("UPDATE loops SET status = ? WHERE id = ? AND status = 102").run(status, loopId);
};

export const listSessions = (db: DatabaseSync): SessionRow[] => {
    return db
        .prepare("SELECT id, name, created_at, cost_pico FROM sessions ORDER BY created_at DESC")
        .all() as unknown as SessionRow[];
};
