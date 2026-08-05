import SqlRite from "@possumtech/sqlrite";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import { Paths } from "../../src/index.ts";
import { rulerCount } from "../../src/core/token-ruler.ts";
import { Mimetypes } from "@plurnk/plurnk-mimetypes";
import type { Db } from "../../src/core/Db.ts";
import type { SchemeManifest } from "../../src/core/scheme-types.ts";
import Owner from "../../src/core/Owner.ts";
import type { PlurnkSchemeContext } from "../../src/core/scheme-types.ts";
import ExecutorRegistry from "../../src/core/ExecutorRegistry.ts";
import PacketWire from "../../src/core/packet-wire.ts";
import GitMembership from "../../src/core/git-membership.ts";
import SchemeCtxImpl from "../../src/core/caps/SchemeCtxImpl.ts";
import LiveSubscriptions from "../../src/core/LiveSubscriptions.ts";

// Auto-discovering Mimetypes for scheme-test contexts. Default-constructed
// Mimetypes walks node_modules for installed `@plurnk/plurnk-mimetypes-*` siblings
// and registers their handlers — the SAME lookup the runtime uses in production,
// INCLUDING the embeddings plugin. So intg exercises the real semantic path —
// deriveEmbeddings tiling + the embedding channel — on every manifest build, not a
// degraded stand-in. The harness must not diverge from production by omitting a
// feature: that omission is exactly what hid the chunk-mimetype crash. Exported for
// tests that build PlurnkSchemeContext directly (File.read, SEND, Engine tests).
export const DEFAULT_MIMETYPES = new Mimetypes();

// Override only the capability under test while retaining a complete configured
// Mimetypes service, including registry-aware classification.
export const mimetypesFixture = (overrides: object): Mimetypes => new Proxy(DEFAULT_MIMETYPES, {
    get(target, property) {
        const source = Object.hasOwn(overrides, property) ? overrides : target;
        const value = Reflect.get(source, property, source) as unknown;
        return typeof value === "function" ? value.bind(source) : value;
    },
});

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
    // Write-time token accounting (SPEC {§tokenomics}). Divisor stand-in mirrors the
    // production boot tripwire; the entry/log write helpers require it.
    tokenize: (text: string) => Math.ceil(text.length / 4),
    ...overrides,
});

export const makeHandlerCtx = (ctx: PlurnkSchemeContext, manifest: SchemeManifest): SchemeCtxImpl =>
    new SchemeCtxImpl(ctx, manifest.name, manifest, new LiveSubscriptions());

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
// without rebuilding plumbing. The normal integration runner clears the prior
// run once before starting, reports this directory, and retains everything
// created by the current run ({§test-artifact-retention}). A bare `node --test
// <file>` bypasses that boundary; use `npm run test:clean-tmp` first when
// invoking the integration tests directly.
export const openMigrated = async (atPath?: string): Promise<Db> => {
    const dbPath = atPath ?? join(TMP_DIR, `db-${crypto.randomUUID()}.db`);
    await mkdir(dirname(dbPath), { recursive: true });
    const db = (await SqlRite.open({
        path: dbPath,
        // The suite already runs eight isolated databases concurrently. One reader
        // per fixture exercises the WAL read lane without multiplying a host-sized
        // pool by every test database.
        readers: 1,
        dir: [
            MIGRATIONS_DIR,
            resolve(PROJECT_ROOT, "src"),
            resolve(PROJECT_ROOT, "test/intg"),
        ],
        functions: [
            resolve(PROJECT_ROOT, "src/schemes/cosine.ts"),
            resolve(PROJECT_ROOT, "src/core/ruler_count.ts"),
        ],
    })) as unknown as Db;
    return db;
};

// {§exec-entry-sink}: idle() settles every spawn tail, including serialized entry/narration
// writes. Tests quiesce streaming EXECs before db.close(); a long-lived child is cancelled first.
export const quiesceExecs = async (schemes: { get(name: string): unknown }): Promise<void> => {
    const exec = schemes.get("exec") as { idle?: () => Promise<void> } | undefined;
    if (exec?.idle !== undefined) await exec.idle();
};

// Test-only viable window ({§definition-table-projection}, {§tokenomics-window-partition}):
// measure current authored teaching once, add configured generation reserves, and double for the
// docs catalog plus headroom. Conclusion fixtures use it so teaching growth cannot make unrelated
// loops impossible; grinder and overflow tests deliberately select their own sub-floor windows.
const _reserves = ["REASONING", "COMPLETION", "SAFETY"].reduce((n, k) => n + Number(process.env[`PLURNK_SERVICE_${k}`] ?? 0), 0);
const _viableWindow = Math.ceil((rulerCount(await readFile(Paths.instructionsSystem, "utf8")) + _reserves) * 2);
export const viableWindow = (): number => _viableWindow;

export const insertWorkspace = async (db: Db, name: string): Promise<number> => {
    const row = await db.test_insert_workspace.get<{ id: number }>({ name });
    if (row === undefined) throw new Error("insertWorkspace: insert returned no row");
    await Owner.commonsId(db, row.id); // {§entry-owner} — the workspace's commons row, eagerly (seeds' owner subselects resolve)
    return row.id;
};

let workerCounter = 0;
export const insertWorker = async (db: Db, workspaceId: number, parentWorkerId: number | null = null, name?: string): Promise<number> => {
    const row = await db.test_insert_worker.get<{ id: number }>({
        workspace_id: workspaceId, name: name ?? `worker-test-${++workerCounter}-${Math.random().toString(36).slice(2, 8)}`, parent_worker_id: parentWorkerId,
    });
    if (row === undefined) throw new Error("insertWorker: insert returned no row");
    return row.id;
};

export const insertLoop = async (db: Db, workerId: number, sequence: number, prompt: string = ""): Promise<number> => {
    const row = await db.test_insert_loop.get<{ id: number }>({
        worker_id: workerId, sequence, prompt,
    });
    if (row === undefined) throw new Error("insertLoop: insert returned no row");
    return row.id;
};

const MIN_PACKET = JSON.stringify({
    tokens: 0,
    sections: [],
    attributions: [],
    assistant: { content: "", ops: [], reasoning: null },
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
// TAG-anchored transform the plurnkdown linter applies ({§jsonplurnk}).
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
    await db.test_set_workspace_root.run({ id: workspaceId, project_root: root });
    await GitMembership.resolveGitMembership(db, workspaceId, undefined);
};

export const insertTurn = async (db: Db, loopId: number, sequence: number, status: number = 200): Promise<number> => {
    const row = await db.test_insert_turn.get<{ id: number }>({
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
    const entry = await db.test_seed_entry_workspace.get<{ id: number }>({
        workspace_id: opts.workspaceId,
        owner_id: opts.ownerId ?? await Owner.commonsId(db, opts.workspaceId),
        scheme: opts.scheme ?? "worker",
        pathname: opts.pathname ?? "/x",
    });
    if (entry === undefined) throw new Error("seedEntryWithChannel: insert returned no row");
    await db.test_seed_channel.run({
        entry_id: entry.id,
        name: opts.channel ?? "body",
        content: opts.content ?? "",
        mimetype: opts.mimetype ?? "text/plain",
        state: opts.state ?? "static",
    });
    return entry.id;
};
export const schemeManifest = (name: string, channels: Record<string, string> = { body: "text/markdown" }, defaultChannel = Object.keys(channels)[0] ?? "body"): SchemeManifest => ({
    name,
    channels,
    defaultChannel,
    category: "data",
    writableBy: ["model", "client", "plurnk", "plugin"],
    volatile: false,
    modelVisible: true,
});
