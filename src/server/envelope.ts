// Envelope lifecycle helpers for client connections. SPEC §13.7.
//
// Every connected client gets a (session, run, client-loop) envelope. Either
// the client picks the session explicitly (session.create / session.attach)
// or the daemon auto-creates one on first requiresInit RPC. In both cases
// the daemon opens a NEW run within the session and a NEW client loop within
// that run; the client loop closes on disconnect.

import type { Db, PrepMethod } from "../core/Db.ts";

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

// Grammar 0.5.0 (#10): Session and Run carry user-renameable string names.
// Defaults are `session-{unixtime}` and `run-{unixtime}`; random suffix avoids
// collisions when two creations land in the same second.
const tsName = (prefix: string): string => {
    const ts = Math.floor(Date.now() / 1000);
    const rand = Math.floor(Math.random() * 0xFFFFFF).toString(36).padStart(4, "0");
    return `${prefix}-${ts}-${rand}`;
};

export const generateSessionName = (): string => tsName("session");
export const generateRunName = (): string => tsName("run");

export const createClientEnvelope = async (db: Db, opts: { name?: string; prefix?: string } = {}): Promise<ClientEnvelope> => {
    const name = opts.name ?? tsName(opts.prefix ?? "session");
    const session = await (db.envelope_insert_session as PrepMethod).get<{ id: number; name: string }>({ name });
    if (session === undefined) throw new Error("createClientEnvelope: session insert returned no row");
    const run = await (db.envelope_insert_run as PrepMethod).get<{ id: number }>({ session_id: session.id, name: generateRunName() });
    if (run === undefined) throw new Error("createClientEnvelope: run insert returned no row");
    const loop = await (db.envelope_insert_client_loop as PrepMethod).get<{ id: number }>({ run_id: run.id });
    if (loop === undefined) throw new Error("createClientEnvelope: loop insert returned no row");
    return { sessionId: session.id, sessionName: session.name, runId: run.id, clientLoopId: loop.id };
};

export const attachToSession = async (db: Db, sessionId: number): Promise<ClientEnvelope> => {
    const session = await (db.envelope_get_session as PrepMethod).get<{ id: number; name: string }>({ id: sessionId });
    if (session === undefined) throw new Error(`session ${sessionId} not found`);
    const run = await (db.envelope_insert_run as PrepMethod).get<{ id: number }>({ session_id: session.id, name: generateRunName() });
    if (run === undefined) throw new Error("attachToSession: run insert returned no row");
    const loop = await (db.envelope_insert_client_loop as PrepMethod).get<{ id: number }>({ run_id: run.id });
    if (loop === undefined) throw new Error("attachToSession: loop insert returned no row");
    return { sessionId: session.id, sessionName: session.name, runId: run.id, clientLoopId: loop.id };
};

export const closeClientLoop = async (db: Db, loopId: number, status: 200 | 499): Promise<void> => {
    await (db.envelope_close_client_loop as PrepMethod).run({ status, loop_id: loopId });
};

export const listSessions = async (db: Db): Promise<SessionRow[]> => {
    return await (db.envelope_list_sessions as PrepMethod).all<SessionRow>();
};
