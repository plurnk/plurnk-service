import SqlRite from "@possumtech/sqlrite";
import { after } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import { Paths } from "../../src/index.ts";
import { rulerCount } from "../../src/core/token-ruler.ts";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";
import type { Db, PrepMethod } from "../../src/core/Db.ts";
import Owner from "../../src/core/Owner.ts";
import type { PlurnkSchemeContext } from "../../src/core/scheme-types.ts";
import ExecutorRegistry from "../../src/core/ExecutorRegistry.ts";
import PacketWire from "../../src/core/packet-wire.ts";
import GitMembership from "../../src/core/git-membership.ts";

// Auto-discovering Mimetypes for scheme-test contexts. Default-constructed
// Mimetypes walks node_modules for installed `@plurnk/plurnk-mimetypes-*` siblings
// and registers their handlers — the SAME lookup the runtime uses in production,
// INCLUDING the embeddings daughter. So intg exercises the real semantic path —
// deriveEmbeddings tiling + the embedding channel — on every manifest build, not a
// degraded stand-in. The harness must not diverge from production by omitting a
// feature: that omission is exactly what hid the chunk-mimetype crash. Exported for
// tests that build PlurnkSchemeContext directly (File.read, SEND, Engine tests).
export const DEFAULT_MIMETYPES = new Mimetypes();

// Test helper: build a PlurnkSchemeContext with sensible defaults. Override
// any field via the argument. Tests that don't exercise db ops can omit it
// (File.read, etc); the unset slot is a tripwire — any unexpected db access
// crashes with a clear TypeError. `mimetypes` is provided by default so
// matcher-using paths don't 500 on missing dispatch capability.
export const makeSchemeCtx = (overrides: Partial<PlurnkSchemeContext> = {}): PlurnkSchemeContext => ({
    db: undefined as unknown as Db,
    workspaceId: 0,
    workerId: 0,
    loopId: 0,
    turnId: 0,
    writer: "model",
    signal: undefined,
    mimetypes: DEFAULT_MIMETYPES,
    // Write-time token accounting (SPEC §tokenomics). Divisor stand-in mirrors the
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
// pre-clean .tmp (test:clean-tmp) so only the current worker's DBs remain —
// no cross-worker accumulation. A bare `node --test <file>` bypasses that, so
// run `npm run test:clean-tmp` yourself first if you go around the script.
// Leak guard — an idle SqlRite handle HOLDS THE PROCESS (possumtech/sqlrite#8): a seeder that
// throws between open and close leaks one, every test settles, and the child process never exits —
// the file wedges silently with zero output. The after() hook closes whatever the tests left open.
const openHandles = new Set<() => Promise<void>>();
let leakGuardArmed = false;
const armLeakGuard = (): void => {
    if (leakGuardArmed) return;
    leakGuardArmed = true;
    after(async () => {
        for (const close of openHandles) await close().catch(() => {}); // already-closed is fine — the guard only exists for the leaked
        openHandles.clear();
    });
};

export const openMigrated = async (atPath?: string): Promise<Db> => {
    armLeakGuard();
    const dbPath = atPath ?? join(TMP_DIR, `db-${crypto.randomUUID()}.db`);
    await mkdir(dirname(dbPath), { recursive: true });
    const db = (await SqlRite.open({
        path: dbPath,
        dir: [
            MIGRATIONS_DIR,
            resolve(PROJECT_ROOT, "src"),
            resolve(PROJECT_ROOT, "test/intg"),
        ],
        functions: [resolve(PROJECT_ROOT, "src/schemes/cosine.ts")],
    })) as unknown as Db;
    const originalClose = db.close.bind(db);
    openHandles.add(originalClose);
    db.close = async () => {
        openHandles.delete(originalClose);
        await originalClose();
        console.error(`[openMigrated] db kept: ${dbPath}`);
    };
    return db;
};

// Quiesce a test's background execs before closing the db: idle() drains every spawn's tail
// INCLUDING its entry()/narration writes (Exec awaits entryChain in its finally), so no detached
// stream write is left in flight to race the db.close — the #432 teardown race. Any test that
// dispatches an EXEC that streams must await this before closing the db. For fast-finishing spawns
// (the common stub); a test holding a long/unbounded child aborts it (KILL/cancel) first.
export const quiesceExecs = async (schemes: { get(name: string): unknown }): Promise<void> => {
    const exec = schemes.get("exec") as { idle?: () => Promise<void> } | undefined;
    if (exec?.idle !== undefined) await exec.idle();
};

// A mock context window sized to the REAL packet floor, not a magic number. The floor is the
// law/definition (grammar's plurnk.md — it GROWS as teaching is added, e.g. #430's harmony channel)
// plus the generation reserves; a docs-foisting turn roughly doubles it (the teaching-docs catalog
// is ~law-sized). A hardcoded window (the old `8192`) silently drifts UNDER that floor as the
// definition grows and the turn hard-413s instead of concluding (#433/#355). This tracks it: measure
// the law ONCE at module load (after setup.ts set the reserves), ×2 to cover the docs catalog +
// headroom. Tight relative to a real model's window (the grinder still engages on large content),
// but never impossible. Use it wherever a test runs a loop to CONCLUSION and just needs the packet
// to fit — NOT for grinder/overflow tests, which deliberately pick a sub-floor window.
const _reserves = ["REASONING", "COMPLETION", "SAFETY"].reduce((n, k) => n + Number(process.env[`PLURNK_SERVICE_${k}`] ?? 0), 0);
const _viableWindow = Math.ceil((rulerCount(await readFile(Paths.instructionsSystem, "utf8")) + _reserves) * 2);
export const viableWindow = (): number => _viableWindow;

export const insertWorkspace = async (db: Db, name: string): Promise<number> => {
    const row = await (db.test_insert_workspace as PrepMethod).get<{ id: number }>({ name });
    if (row === undefined) throw new Error("insertWorkspace: insert returned no row");
    await Owner.commonsId(db, row.id); // {§entry-owner} — the workspace's commons row, eagerly (seeds' owner subselects resolve)
    return row.id;
};

let workerCounter = 0;
export const insertWorker = async (db: Db, workspaceId: number, parentWorkerId: number | null = null, name?: string): Promise<number> => {
    const row = await (db.test_insert_worker as PrepMethod).get<{ id: number }>({
        workspace_id: workspaceId, name: name ?? `run-test-${++workerCounter}-${Math.random().toString(36).slice(2, 8)}`, parent_worker_id: parentWorkerId,
    });
    if (row === undefined) throw new Error("insertWorker: insert returned no row");
    return row.id;
};

export const insertLoop = async (db: Db, workerId: number, sequence: number, prompt: string = ""): Promise<number> => {
    const row = await (db.test_insert_loop as PrepMethod).get<{ id: number }>({
        worker_id: workerId, sequence, prompt,
    });
    if (row === undefined) throw new Error("insertLoop: insert returned no row");
    return row.id;
};

const MIN_PACKET = JSON.stringify({
    tokens: 0,
    sections: [],
    telemetryErrors: [],
    assistant: {
        content: "", ops: [], reasoning: null,
        usage: { prompt: 0, completion: 0, reasoning: 0, cached: 0, total: 0 },
        finishReason: null, model: "mock",
    },
    assistantRaw: null,
});

// Read one section's rendered content off a stored (parsed) packet by name —
// the test-side mirror of the wire/digest read path (PacketWire.sectionContent).
export const packetSection = (packet: unknown, name: string): string =>
    PacketWire.sectionContent(packet as Parameters<typeof PacketWire.sectionContent>[0], name);

// Parse the rendered log section's fenced jsonplurnk array back into structured records — lets
// tests assert on the model's actual log VIEW with field precision (coordinate via `path`, the
// model-facing `target` URI, op, status, origin, display). Strips the ONE deviation (a `body` value
// is a raw <<:::tag … :::tag heredoc) to recover strict JSON — the same content-agnostic,
// TAG-anchored transform the plurnkdown linter applies (§jsonplurnk).
export const logEntries = (packet: unknown): Array<Record<string, unknown>> => {
    const fence = /(`{3,})jsonplurnk\n([\s\S]*?)\n\1(?:\n|$)/.exec(packetSection(packet, "log"));
    if (fence === null) return [];
    const strict = fence[2].replace(/"body":\n<<:::(.+)\n[\s\S]*?\n:::\1\n\}/g, '"body":""}');
    return JSON.parse(strict) as Array<Record<string, unknown>>;
};

// Fixture root-assignment (headless-is-forever: production sets projectRoot ONLY at
// workspace.create; tests that build workspaces piecemeal root them here — a direct UPDATE plus the
// same creation-time membership resolve createClientEnvelope performs).
export const rootWorkspace = async (db: Db, workspaceId: number, root: string): Promise<void> => {
    await (db.test_set_session_root as PrepMethod).run({ id: workspaceId, project_root: root });
    await GitMembership.resolveGitMembership(db, workspaceId, undefined);
};

export const insertTurn = async (db: Db, loopId: number, sequence: number, status: number = 200): Promise<number> => {
    const row = await (db.test_insert_turn as PrepMethod).get<{ id: number }>({
        loop_id: loopId, sequence, status, packet: MIN_PACKET,
    });
    if (row === undefined) throw new Error("insertTurn: insert returned no row");
    return row.id;
};

export const seedEnvelope = async (db: Db, label: string): Promise<{
    workspaceId: number; workerId: number; loopId: number; turnId: number;
}> => {
    const workspaceId = await insertWorkspace(db, label);
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1);
    const turnId = await insertTurn(db, loopId, 1);
    return { workspaceId, workerId, loopId, turnId };
};

// Seed an entry with one channel + visibility row, bypassing scheme handlers.
// Used by tests that need precise DB state for render / visibility / streaming
// assertions.
export const seedEntryWithChannel = async (
    db: Db,
    opts: {
        workspaceId: number;
        workerId?: number;
        // {§entry-owner} — the seeded entry's owner; absent = the workspace commons (shared
        // content). A stream seed passes the owning worker.
        ownerId?: number;
        scheme?: string;
        pathname?: string;
        channel?: string;
        content?: string;
        mimetype?: string;
        state?: "static" | "active" | "closed" | "errored";
    },
): Promise<number> => {
    const entry = await (db.test_seed_entry_session as PrepMethod).get<{ id: number }>({
        workspace_id: opts.workspaceId,
        owner_id: opts.ownerId ?? await Owner.commonsId(db, opts.workspaceId),
        scheme: opts.scheme ?? "known",
        pathname: opts.pathname ?? "/x",
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
