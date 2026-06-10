import SqlRite from "@possumtech/sqlrite";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";
import type { Db, PrepMethod } from "../../src/core/Db.ts";
import type { PlurnkSchemeContext } from "../../src/core/scheme-types.ts";
import ExecutorRegistry from "../../src/core/ExecutorRegistry.ts";

// Auto-discovering Mimetypes for scheme-test contexts. Default-constructed
// Mimetypes walks node_modules for installed `@plurnk/plurnk-mimetypes-*`
// siblings and registers their handlers — same lookup the runtime uses
// in production. Tests exercise the same dispatch surface real callers do.
// Exported for tests that build PlurnkSchemeContext directly (File.read,
// SEND, Engine tests) instead of going through `makeSchemeCtx`.
export const DEFAULT_MIMETYPES = new Mimetypes();

// Test helper: build a PlurnkSchemeContext with sensible defaults. Override
// any field via the argument. Tests that don't exercise db ops can omit it
// (File.read, etc); the unset slot is a tripwire — any unexpected db access
// crashes with a clear TypeError. `mimetypes` is provided by default so
// matcher-using paths don't 500 on missing dispatch capability.
export const makeSchemeCtx = (overrides: Partial<PlurnkSchemeContext> = {}): PlurnkSchemeContext => ({
    db: undefined as unknown as Db,
    sessionId: 0,
    runId: 0,
    loopId: 0,
    turnId: 0,
    writer: "model",
    signal: undefined,
    mimetypes: DEFAULT_MIMETYPES,
    // Write-time token accounting (SPEC §14.2). Divisor stand-in mirrors the
    // production boot tripwire; the entry/log write helpers require it.
    tokenize: (text: string) => Math.ceil(text.length / 4),
    ...overrides,
});

// Boot-style executor registry for EXEC tests. Memoized — built once (discover
// + probe the installed siblings), shared across the suite. Pass to
// engine.setExecutors(...) or makeSchemeCtx({ executors }). Production wires
// this at Daemon.start(); direct-Engine fixtures must provide it themselves.
let _executorsPromise: Promise<ExecutorRegistry> | undefined;
export function testExecutors(): Promise<ExecutorRegistry> {
    _executorsPromise ??= ExecutorRegistry.build();
    return _executorsPromise;
}

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const MIGRATIONS_DIR = resolve(PROJECT_ROOT, "migrations");
const TMP_DIR = resolve(PROJECT_ROOT, "test/intg/.tmp");

// File-backed per-test DB so on-disk consumers (digest tool, future
// forensics) exercise the same artifacts the suite produces. `:memory:`
// hid a column-rename regression in bin/digest.ts for an unknown number
// of PRs. Per-test UUID filenames eliminate parallel collisions.
//
// DBs are KEPT on close — any test that surfaces something worth review
// can be tossed straight at `npm run test:digest -- test/intg/.tmp/db-<id>.db`
// without rebuilding plumbing. The path is logged on close so a failed
// test's forensic db is one grep away. The intg/demo/live runner scripts
// pre-clean .tmp (test:clean-tmp) so only the current run's DBs remain —
// no cross-run accumulation. A bare `node --test <file>` bypasses that, so
// run `npm run test:clean-tmp` yourself first if you go around the script.
export const openMigrated = async (): Promise<Db> => {
    await mkdir(TMP_DIR, { recursive: true });
    const dbPath = join(TMP_DIR, `db-${crypto.randomUUID()}.db`);
    const db = (await SqlRite.open({
        path: dbPath,
        dir: [
            MIGRATIONS_DIR,
            resolve(PROJECT_ROOT, "src"),
            resolve(PROJECT_ROOT, "test/intg"),
        ],
    })) as unknown as Db;
    const originalClose = db.close.bind(db);
    db.close = async () => {
        await originalClose();
        console.error(`[openMigrated] db kept: ${dbPath}`);
    };
    return db;
};

export const insertSession = async (db: Db, name: string): Promise<number> => {
    const row = await (db.test_insert_session as PrepMethod).get<{ id: number }>({ name });
    if (row === undefined) throw new Error("insertSession: insert returned no row");
    return row.id;
};

let runCounter = 0;
export const insertRun = async (db: Db, sessionId: number, parentRunId: number | null = null, name?: string): Promise<number> => {
    const row = await (db.test_insert_run as PrepMethod).get<{ id: number }>({
        session_id: sessionId, name: name ?? `run-test-${++runCounter}-${Math.random().toString(36).slice(2, 8)}`, parent_run_id: parentRunId,
    });
    if (row === undefined) throw new Error("insertRun: insert returned no row");
    return row.id;
};

export const insertLoop = async (db: Db, runId: number, sequence: number, prompt: string = ""): Promise<number> => {
    const row = await (db.test_insert_loop as PrepMethod).get<{ id: number }>({
        run_id: runId, sequence, prompt,
    });
    if (row === undefined) throw new Error("insertLoop: insert returned no row");
    return row.id;
};

const MIN_PACKET = JSON.stringify({
    system: { tokens: 0, system_definition: "", persona: "", index: [], log: [] },
    user: { tokens: 0, prompt: "", telemetry: { budget: "", errors: [] }, system_requirements: "" },
    assistant: {
        content: "", ops: [], reasoning: null,
        usage: { prompt: 0, completion: 0, reasoning: 0, cached: 0, total: 0 },
        finishReason: null, model: "mock",
    },
    assistantRaw: null,
});

export const insertTurn = async (db: Db, loopId: number, sequence: number, status: number = 200): Promise<number> => {
    const row = await (db.test_insert_turn as PrepMethod).get<{ id: number }>({
        loop_id: loopId, sequence, status, packet: MIN_PACKET,
    });
    if (row === undefined) throw new Error("insertTurn: insert returned no row");
    return row.id;
};

export const seedEnvelope = async (db: Db, label: string): Promise<{
    sessionId: number; runId: number; loopId: number; turnId: number;
}> => {
    const sessionId = await insertSession(db, label);
    const runId = await insertRun(db, sessionId);
    const loopId = await insertLoop(db, runId, 1);
    const turnId = await insertTurn(db, loopId, 1);
    return { sessionId, runId, loopId, turnId };
};

// Seed an entry with one channel + visibility row, bypassing scheme handlers.
// Used by tests that need precise DB state for render / visibility / streaming
// assertions.
export const seedEntryWithChannel = async (
    db: Db,
    opts: {
        sessionId: number;
        runId?: number;
        scheme?: string;
        pathname?: string;
        channel?: string;
        content?: string;
        mimetype?: string;
        state?: "static" | "active" | "closed" | "errored";
    },
): Promise<number> => {
    const entry = await (db.test_seed_entry_session as PrepMethod).get<{ id: number }>({
        session_id: opts.sessionId,
        scheme: opts.scheme ?? "known",
        pathname: opts.pathname ?? "x",
    });
    if (entry === undefined) throw new Error("seedEntryWithChannel: insert returned no row");
    await (db.test_seed_channel as PrepMethod).run({
        entry_id: entry.id,
        name: opts.channel ?? "body",
        content: opts.content ?? "",
        mimetype: opts.mimetype ?? "text/plain",
        state: opts.state ?? "static",
    });
    return entry.id;
};
