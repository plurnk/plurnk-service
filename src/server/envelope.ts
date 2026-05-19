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

export interface RunRow {
    id: number;
    name: string;
    created_at: string;
    cost_pico: number;
}

export interface ClientEnvelope {
    sessionId: number;
    sessionName: string;
    runId: number;
    runName: string;
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
    const runName = generateRunName();
    const run = await (db.envelope_insert_run as PrepMethod).get<{ id: number; name: string }>({ session_id: session.id, name: runName });
    if (run === undefined) throw new Error("createClientEnvelope: run insert returned no row");
    const loop = await (db.envelope_insert_client_loop as PrepMethod).get<{ id: number }>({ run_id: run.id });
    if (loop === undefined) throw new Error("createClientEnvelope: loop insert returned no row");
    return { sessionId: session.id, sessionName: session.name, runId: run.id, runName: run.name, clientLoopId: loop.id };
};

// Resolve the run inside a session. Three modes:
// - opts.runId given: lookup by id, verify session ownership (else throw).
// - opts.runName given: lookup by (sessionId, name); reuse if found, create otherwise.
// - neither: create a new run with an auto-generated name (current behavior).
// `runId` and `runName` are alternatives — passing both throws (use one).
const resolveRun = async (db: Db, sessionId: number, opts: { runId?: number; runName?: string }): Promise<{ id: number; name: string }> => {
    if (opts.runId !== undefined && opts.runName !== undefined) {
        throw new Error("attachToSession: pass runId OR runName, not both");
    }
    if (opts.runId !== undefined) {
        const existing = await (db.envelope_get_run_by_id as PrepMethod).get<{ id: number; name: string; session_id: number }>({ id: opts.runId });
        if (existing === undefined) throw new Error(`run ${opts.runId} not found`);
        if (existing.session_id !== sessionId) throw new Error(`run ${opts.runId} belongs to session ${existing.session_id}, not ${sessionId}`);
        return { id: existing.id, name: existing.name };
    }
    if (opts.runName !== undefined) {
        const existing = await (db.envelope_get_run_by_name as PrepMethod).get<{ id: number; name: string }>({ session_id: sessionId, name: opts.runName });
        if (existing !== undefined) return existing;
        const created = await (db.envelope_insert_run as PrepMethod).get<{ id: number; name: string }>({ session_id: sessionId, name: opts.runName });
        if (created === undefined) throw new Error("resolveRun: run insert returned no row");
        return created;
    }
    const created = await (db.envelope_insert_run as PrepMethod).get<{ id: number; name: string }>({ session_id: sessionId, name: generateRunName() });
    if (created === undefined) throw new Error("resolveRun: run insert returned no row");
    return created;
};

export const attachToSession = async (db: Db, sessionId: number, opts: { runId?: number; runName?: string } = {}): Promise<ClientEnvelope> => {
    const session = await (db.envelope_get_session as PrepMethod).get<{ id: number; name: string }>({ id: sessionId });
    if (session === undefined) throw new Error(`session ${sessionId} not found`);
    const run = await resolveRun(db, session.id, opts);
    const loop = await (db.envelope_insert_client_loop as PrepMethod).get<{ id: number }>({ run_id: run.id });
    if (loop === undefined) throw new Error("attachToSession: loop insert returned no row");
    return { sessionId: session.id, sessionName: session.name, runId: run.id, runName: run.name, clientLoopId: loop.id };
};

export const listRunsForSession = async (db: Db, sessionId: number): Promise<RunRow[]> => {
    return await (db.envelope_list_runs_for_session as PrepMethod).all<RunRow>({ session_id: sessionId });
};

export const closeClientLoop = async (db: Db, loopId: number, status: 200 | 499): Promise<void> => {
    await (db.envelope_close_client_loop as PrepMethod).run({ status, loop_id: loopId });
};

export const listSessions = async (db: Db): Promise<SessionRow[]> => {
    return await (db.envelope_list_sessions as PrepMethod).all<SessionRow>();
};
