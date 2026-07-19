// COPY/MOVE INTO file:/// — a disk write under the §membership proposal gate (#2).
// The dest write proposes (202); on accept the file lands + an entry registers.
// MOVE's source-delete is DEFERRED to after the accept, so a rejected MOVE leaves
// the source intact (no data loss behind a pending review).

import test from "node:test";
import Owner from "../../src/core/Owner.ts";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Worker from "../../src/schemes/Worker.ts";
import type { Db, PrepMethod } from "../../src/core/Db.ts";
import type { ParsedPath, KillStatement } from "@plurnk/plurnk-grammar";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn, makeSchemeCtx, DEFAULT_MIMETYPES } from "./_helpers.ts";
import { urlPath, localPath, editStmt, copyStmt, moveStmt } from "./_dsl.ts";

const deferred = <T>(): { promise: Promise<T>; resolve: (v: T) => void } => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
};

type Ctx = { db: Db; engine: Engine; workspaceId: number; workerId: number; loopId: number; turnId: number };

const withWorkspace = async (fn: (root: string, ctx: Ctx) => Promise<void>): Promise<void> => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-cpmv-"));
    const db = await openMigrated();
    try {
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES, tokenize: (t: string) => Math.ceil(t.length / 4) });
        const workspaceId = await insertWorkspace(db, `cpmv-${crypto.randomUUID()}`);
        await (db.test_set_session_project_root as PrepMethod).run({ id: workspaceId, project_root: root });
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "cpmv");
        const turnId = await insertTurn(db, loopId, 1, 102);
        await fn(root, { db, engine, workspaceId, workerId, loopId, turnId });
    } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
};

const seedKnown = (ctx: Ctx, pathname: string, content: string) =>
    new Worker().edit(editStmt(urlPath("worker", `/${pathname}`), content), makeSchemeCtx({ db: ctx.db, workspaceId: ctx.workspaceId, workerId: ctx.workerId }));

const knownEntry = (ctx: Ctx, pathname: string) =>
    (ctx.db.test_get_entry_by_pathname_scheme as PrepMethod).get<{ pathname: string }>({ pathname: `/${pathname}`, scheme: "worker" });

// Materialize a FILE member the production way: on disk + a scheme=null entry + body channel +
// synced_sig — so it's a tracked member (editable, movable, deletable), not untracked disk.
const seedFileMember = async (ctx: Ctx, root: string, rel: string, content: string): Promise<void> => {
    const abs = join(root, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
    const seeded = await (ctx.db.crud_insert_workspace_entry as PrepMethod).get<{ id: number }>({ workspace_id: ctx.workspaceId, owner_id: await Owner.commonsId(ctx.db, ctx.workspaceId), scheme: null, pathname: `/${rel}` });
    await (ctx.db.ops_upsert_channel as PrepMethod).run({ entry_id: seeded?.id, name: "body", content, mimetype: "text/plain", tokens: 0 });
    const st = await stat(abs);
    await (ctx.db.crud_set_synced_sig as PrepMethod).run({ entry_id: seeded?.id, synced_sig: `${st.mtimeMs}:${st.size}` });
};

const fileMember = async (ctx: Ctx, rel: string) =>
    (ctx.db.crud_find_workspace_entry as PrepMethod).get<{ id: number }>({ workspace_id: ctx.workspaceId, owner_id: await Owner.commonsId(ctx.db, ctx.workspaceId), scheme: null, pathname: `/${rel}` });

const killStmt = (target: ParsedPath): KillStatement => ({ op: "KILL", suffix: "", signal: null, target, lineMarker: null, body: null, position: { line: 1, column: 1 } });

const proposeAndResolve = async (ctx: Ctx, statement: Parameters<Engine["dispatch"]>[0]["statement"], decision: "accept" | "reject") => {
    const id = deferred<number>();
    const dispatchPromise = ctx.engine.dispatch({
        statement, workspaceId: ctx.workspaceId, workerId: ctx.workerId, loopId: ctx.loopId, turnId: ctx.turnId,
        sequence: 1, origin: "model", onDispatch: (logId) => id.resolve(logId),
    });
    const logEntryId = await id.promise;
    ctx.engine.resolveProposal(logEntryId, { decision });
    return dispatchPromise;
};

test("[#2-copy-to-file] COPY worker:/// → file:/// proposes then lands the file on accept", async () => {
    await withWorkspace(async (root, ctx) => {
        await seedKnown(ctx, "note", "copied content\n");
        const result = await proposeAndResolve(ctx, copyStmt(urlPath("worker", "/note"), urlPath("file", "/copied.txt")), "accept");
        assert.equal(result.status, 200);
        assert.equal(await readFile(join(root, "copied.txt"), "utf8"), "copied content\n");
        assert.notEqual(await knownEntry(ctx, "note"), undefined, "COPY leaves the source intact");
    });
});

test("[#2-copy-to-file-reject] a rejected COPY into file:/// never touches disk", async () => {
    await withWorkspace(async (root, ctx) => {
        await seedKnown(ctx, "note", "nope\n");
        const result = await proposeAndResolve(ctx, copyStmt(urlPath("worker", "/note"), urlPath("file", "/rejected.txt")), "reject");
        assert.ok(result.status >= 400, "rejected proposal is a 4xx");
        await assert.rejects(readFile(join(root, "rejected.txt"), "utf8"), "the rejected COPY never created the file");
    });
});

test("[#2-move-to-file] MOVE worker:/// → file:/// lands the file AND deletes the source on accept", async () => {
    await withWorkspace(async (root, ctx) => {
        await seedKnown(ctx, "movee", "moved content\n");
        const result = await proposeAndResolve(ctx, moveStmt(urlPath("worker", "/movee"), urlPath("file", "/moved.txt")), "accept");
        assert.equal(result.status, 200);
        assert.equal(await readFile(join(root, "moved.txt"), "utf8"), "moved content\n");
        assert.equal(await knownEntry(ctx, "movee"), undefined, "MOVE deletes the source on accept");
    });
});

test("[#2-move-to-file-reject] a rejected MOVE into file:/// preserves the source (deferred delete)", async () => {
    await withWorkspace(async (_root, ctx) => {
        await seedKnown(ctx, "keepme", "keep\n");
        const result = await proposeAndResolve(ctx, moveStmt(urlPath("worker", "/keepme"), urlPath("file", "/rejected-move.txt")), "reject");
        assert.ok(result.status >= 400, "rejected proposal is a 4xx");
        assert.notEqual(await knownEntry(ctx, "keepme"), undefined, "the source MUST survive a rejected MOVE — the delete was deferred behind the dest write");
    });
});

test("[#2-move-file-to-file] MOVE file:/// → file:/// into a NEW subdir lands the dest AND unlinks the source (no silent 501 noop)", async () => {
    // The file→file MOVE that was a silent noop: File lacked deleteEntry, so #handleMove returned a
    // bare 501 before any write — the model's correct MOVE did nothing while the worker concluded 200.
    await withWorkspace(async (root, ctx) => {
        await seedFileMember(ctx, root, "brief.md", "the brief\n");
        // BARE paths — exactly what the model emits (`MOVE(brief.md):drafts/brief.md`). The source
        // read must normalize `brief.md` → the `/brief.md` member key, or it 404s a real member.
        const result = await proposeAndResolve(ctx, moveStmt(localPath("brief.md"), localPath("drafts/brief.md")), "accept");
        assert.equal(result.status, 200);
        assert.equal(await readFile(join(root, "drafts/brief.md"), "utf8"), "the brief\n", "dest written into the freshly-created subdir");
        await assert.rejects(readFile(join(root, "brief.md"), "utf8"), "source file unlinked — a MOVE, not a COPY");
        assert.equal(await fileMember(ctx, "brief.md"), undefined, "source entry deregistered");
    });
});

test("[§membership-edit-membership-gate] EDIT onto an existing NON-member file is refused (403) and never clobbers it", async () => {
    // The unfair edge: a file exists on disk but was never tracked (git/client left it out), so it's
    // INVISIBLE to the model. The model, blind to it, tries to "create" it — and MUST NOT be able to
    // overwrite it. The refusal is opaque (never reveals the file exists) so the model can't probe the
    // untracked filesystem by watching which creates fail.
    await withWorkspace(async (root, ctx) => {
        await writeFile(join(root, "AGENTS.md"), "SECRET untracked policy\n", "utf8"); // on disk, NOT a member
        // A refused create returns 403 outright — it never PROPOSES (no review to accept), so dispatch directly.
        const result = await ctx.engine.dispatch({
            statement: editStmt(urlPath("file", "/AGENTS.md"), "# the model's clobbering content"),
            workspaceId: ctx.workspaceId, workerId: ctx.workerId, loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
        });
        assert.equal(result.status, 403, "create over an existing non-member is refused outright, never a proposal, never clobbered");
        assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), "SECRET untracked policy\n", "the untracked file is untouched");
    });
});

test("KILL of a file is a destructive host delete → it PROPOSES; on accept the file is unlinked + deregistered", async () => {
    await withWorkspace(async (root, ctx) => {
        await seedFileMember(ctx, root, "doomed.txt", "delete me\n");
        const result = await proposeAndResolve(ctx, killStmt(localPath("doomed.txt")), "accept");
        assert.equal(result.status, 200, "KILL proposed for review, then applied on accept");
        await assert.rejects(readFile(join(root, "doomed.txt"), "utf8"), "the host file was unlinked");
        assert.equal(await fileMember(ctx, "doomed.txt"), undefined, "the entry was deregistered");
    });
});

test("a REJECTED KILL of a file preserves it — a destructive delete never bypasses review", async () => {
    await withWorkspace(async (root, ctx) => {
        await seedFileMember(ctx, root, "keep.txt", "keep me\n");
        const result = await proposeAndResolve(ctx, killStmt(localPath("keep.txt")), "reject");
        assert.ok(result.status >= 400, "rejected proposal is a 4xx");
        assert.equal(await readFile(join(root, "keep.txt"), "utf8"), "keep me\n", "the file survives — review gates the destructive op, never a silent unlink");
    });
});

test("KILL of a NON-member file is 404 — the model can't delete untracked disk it can't see", async () => {
    await withWorkspace(async (root, ctx) => {
        await writeFile(join(root, "untracked.txt"), "not yours\n", "utf8"); // on disk, NOT a member
        const result = await ctx.engine.dispatch({
            statement: killStmt(localPath("untracked.txt")),
            workspaceId: ctx.workspaceId, workerId: ctx.workerId, loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
        });
        assert.equal(result.status, 404, "a non-member KILL is 404 — invisible, never touched");
        assert.equal(await readFile(join(root, "untracked.txt"), "utf8"), "not yours\n", "the untracked file is untouched");
    });
});
