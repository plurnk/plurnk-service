// Envelope lifecycle helpers for client connections. SPEC §13.7.
//
// Every connected client gets a (session, run, client-loop) envelope. Either
// the client picks the session explicitly (session.create / session.attach)
// or the daemon auto-creates one on first requiresInit RPC. In both cases
// the daemon opens a NEW run within the session and a NEW client loop within
// that run; the client loop closes on disconnect.

import type { Db, PrepMethod } from "../core/Db.ts";
import { resolveGitMembership } from "../core/git-membership.ts";

export interface SessionRow {
    id: number;
    name: string;
    project_root: string | null;
    persona: string | null;
    created_at: string;
    cost_pico: number;
}

export interface RunRow {
    id: number;
    name: string;
    created_at: string;
    cost_pico: number;
}

// Per-connection envelope. clientLoopId starts null and is lazily
// allocated on the first client-origin op (op.edit, op.read, etc.) — a
// connection that only calls loop.run never spends a loop sequence on
// an empty client envelope, so the model's first run is loop 1, not 2.
export interface ClientEnvelope {
    sessionId: number;
    sessionName: string;
    projectRoot: string | null;
    sessionPersona: string | null;
    runId: number;
    runName: string;
    runPersona: string | null;
    clientLoopId: number | null;
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

export const createClientEnvelope = async (db: Db, opts: { name?: string; prefix?: string; projectRoot?: string | null; persona?: string | null } = {}): Promise<ClientEnvelope> => {
    const name = opts.name ?? tsName(opts.prefix ?? "session");
    const projectRoot = opts.projectRoot ?? null;
    const persona = opts.persona ?? null;
    const session = await (db.envelope_insert_session as PrepMethod).get<{ id: number; name: string; project_root: string | null; persona: string | null }>({ name, project_root: projectRoot, persona });
    if (session === undefined) throw new Error("createClientEnvelope: session insert returned no row");
    // SPEC §14.3 D4 — establish git-ls-files membership at workspace setup so
    // tracked files are members before the first op. No-op when projectRoot is
    // null (headless) or not a git working tree.
    await resolveGitMembership(db, session.id, undefined);
    const runName = generateRunName();
    const run = await (db.envelope_insert_run as PrepMethod).get<{ id: number; name: string; persona: string | null }>({ session_id: session.id, name: runName, persona: null });
    if (run === undefined) throw new Error("createClientEnvelope: run insert returned no row");
    return {
        sessionId: session.id, sessionName: session.name,
        projectRoot: session.project_root, sessionPersona: session.persona,
        runId: run.id, runName: run.name, runPersona: run.persona,
        clientLoopId: null,
    };
};

// Resolve the run inside a session. Three modes:
// - opts.runId given: lookup by id, verify session ownership (else throw).
// - opts.runName given: lookup by (sessionId, name); reuse if found, create otherwise.
// - neither: create a new run with an auto-generated name (current behavior).
// `runId` and `runName` are alternatives — passing both throws (use one).
// persona handling: only set when creating a NEW run. Reusing an existing
// run (by runId or by runName matching an existing row) carries forward
// whatever persona was stored on that row — overrides target NEW runs.
const resolveRun = async (db: Db, sessionId: number, opts: { runId?: number; runName?: string; persona?: string | null }): Promise<{ id: number; name: string; persona: string | null }> => {
    if (opts.runId !== undefined && opts.runName !== undefined) {
        throw new Error("attachToSession: pass runId OR runName, not both");
    }
    if (opts.runId !== undefined) {
        const existing = await (db.envelope_get_run_by_id as PrepMethod).get<{ id: number; name: string; session_id: number; persona: string | null }>({ id: opts.runId });
        if (existing === undefined) throw new Error(`run ${opts.runId} not found`);
        if (existing.session_id !== sessionId) throw new Error(`run ${opts.runId} belongs to session ${existing.session_id}, not ${sessionId}`);
        return { id: existing.id, name: existing.name, persona: existing.persona };
    }
    if (opts.runName !== undefined) {
        const existing = await (db.envelope_get_run_by_name as PrepMethod).get<{ id: number; name: string; persona: string | null }>({ session_id: sessionId, name: opts.runName });
        if (existing !== undefined) return existing;
        const created = await (db.envelope_insert_run as PrepMethod).get<{ id: number; name: string; persona: string | null }>({ session_id: sessionId, name: opts.runName, persona: opts.persona ?? null });
        if (created === undefined) throw new Error("resolveRun: run insert returned no row");
        return created;
    }
    const created = await (db.envelope_insert_run as PrepMethod).get<{ id: number; name: string; persona: string | null }>({ session_id: sessionId, name: generateRunName(), persona: opts.persona ?? null });
    if (created === undefined) throw new Error("resolveRun: run insert returned no row");
    return created;
};

export const attachToSession = async (db: Db, sessionId: number, opts: { runId?: number; runName?: string; persona?: string | null } = {}): Promise<ClientEnvelope> => {
    const session = await (db.envelope_get_session as PrepMethod).get<{ id: number; name: string; project_root: string | null; persona: string | null }>({ id: sessionId });
    if (session === undefined) throw new Error(`session ${sessionId} not found`);
    const run = await resolveRun(db, session.id, opts);
    return {
        sessionId: session.id, sessionName: session.name,
        projectRoot: session.project_root, sessionPersona: session.persona,
        runId: run.id, runName: run.name, runPersona: run.persona,
        clientLoopId: null,
    };
};

// Lazy client-loop allocator. Called from dispatchAsClient on the first
// client-origin op for this connection; subsequent ops reuse the same
// loop until the connection closes.
export const ensureClientLoop = async (db: Db, runId: number): Promise<number> => {
    const loop = await (db.envelope_insert_client_loop as PrepMethod).get<{ id: number }>({ run_id: runId });
    if (loop === undefined) throw new Error("ensureClientLoop: loop insert returned no row");
    return loop.id;
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

// Updates sessions.project_root for an existing session and returns the new
// value. Throws if the session does not exist. Used by session.set_root (F.1).
export const updateSessionProjectRoot = async (db: Db, sessionId: number, projectRoot: string | null): Promise<string | null> => {
    const row = await (db.envelope_update_session_project_root as PrepMethod).get<{ id: number; name: string; project_root: string | null; persona: string | null }>({ id: sessionId, project_root: projectRoot });
    if (row === undefined) throw new Error(`session ${sessionId} not found`);
    // SPEC §14.3 D4 — (re)establish git-ls-files membership when the workspace
    // pointer changes. No-op on null (headless) or non-git roots.
    await resolveGitMembership(db, sessionId, undefined);
    return row.project_root;
};

// Updates sessions.persona. Mirrors updateSessionProjectRoot. Used by
// session.set_persona (issue #150).
export const updateSessionPersona = async (db: Db, sessionId: number, persona: string | null): Promise<string | null> => {
    const row = await (db.envelope_update_session_persona as PrepMethod).get<{ id: number; name: string; project_root: string | null; persona: string | null }>({ id: sessionId, persona });
    if (row === undefined) throw new Error(`session ${sessionId} not found`);
    return row.persona;
};
