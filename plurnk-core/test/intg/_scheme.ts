// Integration harness: scheme and handler contexts, proposal settlement, look-through reads.

import { Mimetypes } from "@plurnk/plurnk-mimetypes";
import type { Db } from "../../src/core/Db.ts";
import type { SchemeManifest } from "../../src/core/scheme-types.ts";
import type { PlurnkSchemeContext } from "../../src/core/scheme-types.ts";
import SchemeCtxImpl from "../../src/core/caps/SchemeCtxImpl.ts";
import LiveSubscriptions from "../../src/core/LiveSubscriptions.ts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import type { ReadStatement } from "@plurnk/plurnk-contracts";
import { Results, type EntryReadResult } from "@plurnk/plurnk-schemes";
import { contentHash } from "../../src/core/content-hash.ts";
import { insertLoop } from "./_db.ts";

// Discover the same installed content handlers as the runtime.
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

export const makeHandlerCtx = async (
    ctx: PlurnkSchemeContext,
    manifest: SchemeManifest,
    authority = "",
): Promise<SchemeCtxImpl> =>
    new SchemeCtxImpl(ctx, manifest.name, manifest, new LiveSubscriptions(), {
        authority,
    });

// {§http-outbound-proposes} — POST, PUT and the remote DELETE propose before anything leaves the
// process. A test that drives a scheme directly (no dispatcher, so no settlement arrives) and
// means to observe the REQUEST settles the proposal itself, exactly as the dispatcher would on
// an accept. A non-proposal result passes through, so a refusal keeps its own status.
export const settleOutbound = async <T extends { status: number; attrs?: object }>(
    handler: { applyResolution?: (request: { attrs: object; metadata: readonly string[] | null; body?: string }, ctx: never) => Promise<T> },
    result: T,
    ctx: unknown,
    metadata: readonly string[] | null = null,
): Promise<T> => {
    if (result.status !== 202 || handler.applyResolution === undefined) return result;
    return handler.applyResolution({ attrs: result.attrs ?? {}, metadata }, ctx as never);
};

// {§http-outbound-proposes} — a client dispatch of an operation that proposes needs a settlement:
// a real client answers the `loop/proposal` event it receives. A test that only means to observe
// the operation does the same. A dispatch that never proposes passes straight through.
interface ProposalSettler {
    subscribeToEvents(listener: (workspaceId: number | null, method: string, params: unknown) => void): () => void;
    resolveProposal(logEntryId: number, resolution: { decision: "accept" | "reject" }): void;
}

export const dispatchSettled = async <T>(
    daemon: ProposalSettler,
    run: () => Promise<T>,
    decision: "accept" | "reject" = "accept",
): Promise<T> => {
    const proposed = Promise.withResolvers<number>();
    const unsubscribe = daemon.subscribeToEvents((_workspaceId, method, params) => {
        if (method === "loop/proposal") proposed.resolve((params as { logEntryId: number }).logEntryId);
    });
    try {
        const pending = run();
        // Whichever comes first: the dispatch finished (it never proposed) or a proposal to answer.
        // Racing costs nothing either way — a waiting poll would spend its whole budget on every
        // operation that refuses before proposing.
        const logEntryId = await Promise.race([pending.then(() => null), proposed.promise]);
        if (logEntryId !== null) daemon.resolveProposal(logEntryId, { decision });
        return await pending;
    } finally {
        unsubscribe();
    }
};

export const seedStaticChannel = async (
    db: Db,
    entryId: number | undefined,
    channel: { readonly name: string; readonly content: string; readonly mimetype: string; readonly weight?: number },
): Promise<void> => {
    if (entryId === undefined) throw new Error("A static channel fixture requires an entry id.");
    await db.test_seed_channel_hashed.run({
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
    // A context that carries a registry looks through an engine that has it, as the daemon does.
    if (ctx.executors !== undefined) engine.setExecutors(ctx.executors);
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

export const schemeManifest = (name: string, channels: Record<string, string> = { body: "text/markdown" }, defaultChannel = Object.keys(channels)[0] ?? "body"): SchemeManifest => ({
    name,
    channels,
    defaultChannel,
    category: "data",
    writableBy: ["model", "client", "_plurnk", "plugin"],
    volatile: false,
    modelVisible: true,
});
