import SqlRite from "@possumtech/sqlrite";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import { Paths } from "../../src/index.ts";
import { contentWeight } from "../../src/core/content-weight.ts";
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
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import type { ReadStatement } from "@plurnk/plurnk-contracts";
import { Results, type EntryReadResult } from "@plurnk/plurnk-schemes";
import { contentHash } from "../../src/core/content-hash.ts";
import {
    assessRequestCapacity,
    resolveGenerationEnvelopeFromEnv,
    type ChatMessage,
    type ProviderRequestCapacity,
} from "@plurnk/plurnk-providers";

export const testProviderCapacity = (
    messages: readonly ChatMessage[],
    contextWindow: number | null,
    outputBudget = 1,
): ProviderRequestCapacity => assessRequestCapacity({
    contextWindow,
    maxInputTokens: null,
    maxOutputTokens: null,
    outputBudget,
    reasoningBudget: null,
    measurement: {
        kind: "exact",
        tokens: messages.reduce((sum, { content }) => sum + Math.ceil(content.length / 2), 0),
        source: "core:test-fixture",
    },
});

export const testDeferredProviderCapacity = (source = "core:test-fixture"): ProviderRequestCapacity =>
    assessRequestCapacity({
        contextWindow: null,
        maxInputTokens: null,
        maxOutputTokens: null,
        outputBudget: null,
        reasoningBudget: null,
        measurement: {
            kind: "unavailable",
            source,
            detail: "fixture has no physical model envelope",
        },
    });

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
    // Write-time curation weight (SPEC {§tokenomics}). Divisor stand-in mirrors
    // the production boot tripwire; the entry/log write helpers require it.
    weigh: (text: string) => Math.ceil(text.length / 4),
    ...overrides,
});

export const makeHandlerCtx = (
    ctx: PlurnkSchemeContext,
    manifest: SchemeManifest,
    authority = "",
): SchemeCtxImpl =>
    new SchemeCtxImpl(ctx, manifest.name, manifest, new LiveSubscriptions(), { authority });

export const seedStaticChannel = async (
    db: Db,
    entryId: number | undefined,
    channel: { readonly name: string; readonly content: string; readonly mimetype: string; readonly weight?: number },
): Promise<void> => {
    if (entryId === undefined) throw new Error("A static channel fixture requires an entry id.");
    await db.crud_write_channel.run({
        entry_id: entryId,
        name: channel.name,
        content: channel.content,
        mimetype: channel.mimetype,
        weight: channel.weight ?? 0,
        content_hash: contentHash(channel.content),
        state: "static",
        producer_result: null,
    });
};

// Exercise a scheme READ through the real universal dispatch composition while
// retaining the surrounding test's database and principal coordinates.
export const lookThroughScheme = async (
    name: string,
    handler: object | null,
    statement: ReadStatement,
    ctx: PlurnkSchemeContext,
): Promise<EntryReadResult> => {
    const existingLoop = ctx.loopId > 0
        ? { id: ctx.loopId }
        : await ctx.db.test_get_loop_by_worker.get<{ id: number }>({ worker_id: ctx.workerId });
    const loopId = existingLoop?.id ?? await insertLoop(ctx.db, ctx.workerId, 1);
    const schemes = new SchemeRegistry();
    if (handler !== null) schemes.register(name, handler);
    const engine = new Engine({
        db: ctx.db,
        schemes,
        mimetypes: ctx.mimetypes,
        weigh: ctx.weigh,
    });
    const result = await engine.look({
        statement,
        workspaceId: ctx.workspaceId,
        workerId: ctx.workerId,
        loopId,
        origin: ctx.writer,
    });
    Results.assertReadResult(result);
    return result as EntryReadResult;
};

export const readLog = (
    statement: ReadStatement,
    ctx: PlurnkSchemeContext,
): Promise<EntryReadResult> => lookThroughScheme("log", null, statement, ctx);

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
// can be tossed straight at `npm run dev:digest -- test/intg/.tmp/db-<id>.db`
// without rebuilding plumbing. The normal integration runner clears the prior
// run once before starting, reports this directory, and retains everything
// created by the current run ({§test-artifact-retention}). A bare `node --test
// <file>` bypasses that boundary; use `npm run artifacts:clean` first when
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
            resolve(PROJECT_ROOT, "src/core/content_weight.ts"),
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

// Test-only viable context ({§definition-table-projection}, {§tokenomics-window-partition}):
// preserve twice the current authored teaching as input under the provider-owned
// output policy. Conclusion fixtures stay viable as teaching grows; pressure
// tests pin their own envelopes. Resolve the shipped percentage or an operator's
// absolute through the production contract instead of reproducing its syntax.
const _testInputCapacity = contentWeight(await readFile(Paths.instructionsSystem, "utf8")) * 2;
let _viableWindow: number | undefined;
export const viableWindow = (): number => {
    if (_viableWindow !== undefined) return _viableWindow;
    const absoluteEnvelope = resolveGenerationEnvelopeFromEnv(process.env, null);
    let candidate = absoluteEnvelope.outputBudget === null
        ? Math.max(2, _testInputCapacity)
        : _testInputCapacity + absoluteEnvelope.outputBudget;
    while (true) {
        const { outputBudget } = resolveGenerationEnvelopeFromEnv(process.env, candidate);
        if (outputBudget === null) {
            throw new TypeError("integration setup requires PLURNK_PROVIDERS_OUTPUT_BUDGET");
        }
        if (candidate - outputBudget >= _testInputCapacity) break;
        if (candidate > Number.MAX_SAFE_INTEGER / 2) {
            throw new RangeError("integration setup could not derive a safe mock context window");
        }
        candidate *= 2;
    }
    _viableWindow = candidate;
    return candidate;
};

export const insertWorkspace = async (db: Db, name: string): Promise<number> => {
    const row = await db.test_insert_workspace.get<{ id: number }>({ name });
    if (row === undefined) throw new Error("insertWorkspace: insert returned no row");
    await Owner.commonsId(db, row.id); // {§entry-owner} — the workspace's commons row, eagerly (seeds' owner subselects resolve)
    return row.id;
};

let workerCounter = 0;
export const insertWorker = async (
    db: Db,
    workspaceId: number,
    parentWorkerId: number | null = null,
    name?: string,
    origin: "model" | "client" | "_plurnk" = "client",
): Promise<number> => {
    const row = await db.test_insert_worker.get<{ id: number }>({
        workspace_id: workspaceId,
        name: name ?? `worker-test-${++workerCounter}-${Math.random().toString(36).slice(2, 8)}`,
        parent_worker_id: parentWorkerId,
        origin,
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
    weight: 0,
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
// tests assert on the model's actual log VIEW with field precision (`path` owns coordinate + OP,
// alongside the model-facing target URI, status, origin, and display). Strips the ONE deviation (a raw
// multiline `body` string whose physical lines all carry numeric or anchored coordinates) to recover strict JSON ({§jsonplurnk}).
export const logEntries = (packet: unknown): Array<Record<string, unknown>> => {
    const fence = /(`{3,})jsonplurnk\n([\s\S]*?)\n\1(?:\n|$)/.exec(packetSection(packet, "log"));
    if (fence === null) return [];
    const block = fence[2];
    const opener = /"body":"\n/g;
    let strict = "";
    let cursor = 0;
    let match: RegExpExecArray | null;
    while ((match = opener.exec(block)) !== null) {
        const contentStart = match.index + match[0].length;
        let closeStart = -1;
        let at = contentStart;
        let lines = 0;
        while (at < block.length) {
            if (block[at] === '"' && (block[at + 1] === "}" || block[at + 1] === ",")) {
                if (lines === 0) throw new Error("jsonplurnk test helper found an empty raw multiline body");
                closeStart = at;
                break;
            }
            const newline = block.indexOf("\n", at);
            const end = newline === -1 ? block.length : newline;
            if (!/^(?: *[1-9]\d*:|@[0-9A-Za-z]{5} +[1-9]\d*:)/.test(block.slice(at, end).replace(/\r$/, ""))) {
                throw new Error("jsonplurnk test helper found a raw body line without coordinates");
            }
            lines++;
            if (newline === -1) break;
            at = newline + 1;
        }
        if (closeStart === -1) throw new Error("jsonplurnk test helper found an unterminated raw multiline body");
        strict += block.slice(cursor, match.index)
            + '"body":'
            + JSON.stringify(block.slice(contentStart, closeStart));
        cursor = closeStart + 1;
        opener.lastIndex = cursor;
    }
    return JSON.parse(strict + block.slice(cursor)) as Array<Record<string, unknown>>;
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

export const insertOperationTurn = async (
    db: Db,
    loopId: number,
    sequence: number,
    producer: "client" | "plugin" | "_plurnk",
    status: number = 200,
): Promise<number> => {
    const row = await db.test_insert_operation_turn.get<{ id: number }>({
        loop_id: loopId,
        sequence,
        producer,
        status,
    });
    if (row === undefined) throw new Error("insertOperationTurn: insert returned no row");
    return row.id;
};

export const seedEnvelope = async (
    db: Db,
    label: string,
    options: { producer?: "model" | "client" | "plugin" | "_plurnk" } = {},
): Promise<{
    workspaceId: number; workerId: number; loopId: number; turnId: number;
}> => {
    const workspaceId = await insertWorkspace(db, label);
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1);
    const producer = options.producer ?? "model";
    const turnId = producer === "model"
        ? await insertTurn(db, loopId, 1)
        : await insertOperationTurn(db, loopId, 1, producer);
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
        authority?: string;
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
        authority: opts.authority ?? "",
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
    writableBy: ["model", "client", "_plurnk", "plugin"],
    volatile: false,
    modelVisible: true,
});
