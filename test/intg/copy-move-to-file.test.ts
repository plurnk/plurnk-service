// COPY/MOVE INTO file:// — a disk write under the §14.3 proposal gate (#2).
// The dest write proposes (202); on accept the file lands + an entry registers.
// MOVE's source-delete is DEFERRED to after the accept, so a rejected MOVE leaves
// the source intact (no data loss behind a pending review).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Known from "../../src/schemes/Known.ts";
import type { Db, PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertSession, insertRun, insertLoop, insertTurn, makeSchemeCtx, DEFAULT_MIMETYPES } from "./_helpers.ts";
import { urlPath, editStmt, copyStmt, moveStmt } from "./_dsl.ts";

const deferred = <T>(): { promise: Promise<T>; resolve: (v: T) => void } => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
};

type Ctx = { db: Db; engine: Engine; sessionId: number; runId: number; loopId: number; turnId: number };

const withWorkspace = async (fn: (root: string, ctx: Ctx) => Promise<void>): Promise<void> => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-cpmv-"));
    const db = await openMigrated();
    try {
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES, tokenize: (t: string) => Math.ceil(t.length / 4) });
        const sessionId = await insertSession(db, `cpmv-${crypto.randomUUID()}`);
        await (db.test_set_session_project_root as PrepMethod).run({ id: sessionId, project_root: root });
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "cpmv");
        const turnId = await insertTurn(db, loopId, 1, 102);
        await fn(root, { db, engine, sessionId, runId, loopId, turnId });
    } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
};

const seedKnown = (ctx: Ctx, pathname: string, content: string) =>
    new Known().edit(editStmt(urlPath("known", pathname), content), makeSchemeCtx({ db: ctx.db, sessionId: ctx.sessionId, runId: ctx.runId }));

const knownEntry = (ctx: Ctx, pathname: string) =>
    (ctx.db.test_get_entry_by_pathname_scheme as PrepMethod).get<{ pathname: string }>({ pathname, scheme: "known" });

const proposeAndResolve = async (ctx: Ctx, statement: Parameters<Engine["dispatch"]>[0]["statement"], decision: "accept" | "reject") => {
    const id = deferred<number>();
    const dispatchPromise = ctx.engine.dispatch({
        statement, sessionId: ctx.sessionId, runId: ctx.runId, loopId: ctx.loopId, turnId: ctx.turnId,
        sequence: 1, origin: "model", onDispatch: (logId) => id.resolve(logId),
    });
    const logEntryId = await id.promise;
    ctx.engine.resolveProposal(logEntryId, { decision });
    return dispatchPromise;
};

test("[#2-copy-to-file] COPY known:// → file:// proposes then lands the file on accept", async () => {
    await withWorkspace(async (root, ctx) => {
        await seedKnown(ctx, "note", "copied content\n");
        const result = await proposeAndResolve(ctx, copyStmt(urlPath("known", "note"), urlPath("file", "copied.txt")), "accept");
        assert.equal(result.status, 200);
        assert.equal(await readFile(join(root, "copied.txt"), "utf8"), "copied content\n");
        assert.notEqual(await knownEntry(ctx, "note"), undefined, "COPY leaves the source intact");
    });
});

test("[#2-copy-to-file-reject] a rejected COPY into file:// never touches disk", async () => {
    await withWorkspace(async (root, ctx) => {
        await seedKnown(ctx, "note", "nope\n");
        const result = await proposeAndResolve(ctx, copyStmt(urlPath("known", "note"), urlPath("file", "rejected.txt")), "reject");
        assert.ok(result.status >= 400, "rejected proposal is a 4xx");
        await assert.rejects(readFile(join(root, "rejected.txt"), "utf8"), "the rejected COPY never created the file");
    });
});

test("[#2-move-to-file] MOVE known:// → file:// lands the file AND deletes the source on accept", async () => {
    await withWorkspace(async (root, ctx) => {
        await seedKnown(ctx, "movee", "moved content\n");
        const result = await proposeAndResolve(ctx, moveStmt(urlPath("known", "movee"), urlPath("file", "moved.txt")), "accept");
        assert.equal(result.status, 200);
        assert.equal(await readFile(join(root, "moved.txt"), "utf8"), "moved content\n");
        assert.equal(await knownEntry(ctx, "movee"), undefined, "MOVE deletes the source on accept");
    });
});

test("[#2-move-to-file-reject] a rejected MOVE into file:// preserves the source (deferred delete)", async () => {
    await withWorkspace(async (_root, ctx) => {
        await seedKnown(ctx, "keepme", "keep\n");
        const result = await proposeAndResolve(ctx, moveStmt(urlPath("known", "keepme"), urlPath("file", "rejected-move.txt")), "reject");
        assert.ok(result.status >= 400, "rejected proposal is a 4xx");
        assert.notEqual(await knownEntry(ctx, "keepme"), undefined, "the source MUST survive a rejected MOVE — the delete was deferred behind the dest write");
    });
});
