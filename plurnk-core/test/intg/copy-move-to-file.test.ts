// COPY/MOVE into file:/// — a disk write under {§copy-cross-scheme-copy},
// {§move-cross-scheme-move}, and the {§proposal} gate.
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
import type { ProposalPendingEvent } from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Worker from "../../src/schemes/Worker.ts";
import type { Db } from "../../src/core/Db.ts";
import type { ParsedPath, KillStatement } from "@plurnk/plurnk-contracts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn, makeSchemeCtx, DEFAULT_MIMETYPES, seedStaticChannel } from "./_helpers.ts";
import { urlPath, localPath, editStmt, copyStmt, moveStmt, fullReplace } from "./_dsl.ts";

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
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES, weigh: (t: string) => Math.ceil(t.length / 4) });
        const workspaceId = await insertWorkspace(db, `cpmv-${crypto.randomUUID()}`);
        await db.test_set_workspace_project_root.run({ id: workspaceId, project_root: root });
        // {§fs-write-surface} — a non-git root grants nothing; the fixture is the CLIENT granting creates.
        await db.crud_insert_workspace_constraint.run({ workspace_id: workspaceId, effect: "pick", glob: "**" });
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "cpmv");
        const turnId = await insertTurn(db, loopId, 1, 102);
        await fn(root, { db, engine, workspaceId, workerId, loopId, turnId });
    } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
};

const seedWorker = (ctx: Ctx, pathname: string, content: string) =>
    new Worker().edit(editStmt(urlPath("worker", `/${pathname}`), content), makeSchemeCtx({ db: ctx.db, workspaceId: ctx.workspaceId, workerId: ctx.workerId }));

const workerEntry = (ctx: Ctx, pathname: string) =>
    ctx.db.test_get_entry_by_pathname_scheme.get<{ pathname: string }>({ pathname: `/${pathname}`, scheme: "worker" });

// Materialize a FILE member the production way: on disk + a scheme=file entry + body channel +
// synced_sig — so it's a tracked member (editable, movable, deletable), not untracked disk.
const seedFileMember = async (ctx: Ctx, root: string, rel: string, content: string): Promise<void> => {
    const abs = join(root, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
    const seeded = await ctx.db.crud_insert_workspace_entry.get<{ id: number }>({ workspace_id: ctx.workspaceId, owner_id: await Owner.commonsId(ctx.db, ctx.workspaceId), scheme: "file", pathname: `${rel}` });
    await seedStaticChannel(ctx.db, seeded?.id, {
        name: "body",
        content,
        mimetype: rel.endsWith(".md") ? "text/markdown" : "text/plain",
    });
    const st = await stat(abs);
    await ctx.db.crud_set_synced_sig.run({ entry_id: seeded?.id, synced_sig: `${st.mtimeMs}:${st.size}` });
};

const fileMember = async (ctx: Ctx, rel: string) =>
    ctx.db.crud_find_workspace_entry.get<{ id: number }>({ workspace_id: ctx.workspaceId, owner_id: await Owner.commonsId(ctx.db, ctx.workspaceId), scheme: "file", pathname: `${rel}` });

const killStmt = (target: ParsedPath): KillStatement => ({ op: "KILL", suffix: "", signal: null, target, lineMarker: null, body: null, position: { line: 1, column: 1 } });

const proposeAndResolve = async (
    ctx: Ctx,
    statement: Parameters<Engine["dispatch"]>[0]["statement"],
    decision: "accept" | "reject",
    body?: string,
) => {
    const id = deferred<number>();
    const dispatchPromise = ctx.engine.dispatch({
        statement, workspaceId: ctx.workspaceId, workerId: ctx.workerId, loopId: ctx.loopId, turnId: ctx.turnId,
        sequence: 1, origin: "model", onDispatch: (logId) => id.resolve(logId),
    });
    const logEntryId = await id.promise;
    ctx.engine.resolveProposal(logEntryId, {
        decision,
        ...(body === undefined ? {} : { body }),
    });
    return dispatchPromise;
};

test("{§copy-cross-scheme-copy}: COPY worker:/// → file:/// proposes then lands on accept", async () => {
    await withWorkspace(async (root, ctx) => {
        await seedWorker(ctx, "note", "copied content\n");
        const result = await proposeAndResolve(ctx, copyStmt(urlPath("worker", "/note"), urlPath("file", "/copied.txt")), "accept");
        assert.equal(result.status, 200);
        assert.deepEqual(result.effects, [{
            target: "copied.txt",
            action: "create",
        }]);
        assert.equal(await readFile(join(root, "copied.txt"), "utf8"), "copied content\n");
        assert.notEqual(await workerEntry(ctx, "note"), undefined, "COPY leaves the source intact");
    });
});

test("live and reconnect use one COPY destination proposal projection", async () => {
    await withWorkspace(async (_root, ctx) => {
        await seedWorker(ctx, "note", "copied content\n");
        const observed = deferred<ProposalPendingEvent>();
        ctx.engine.onProposalPending((event) => observed.resolve(event));
        const dispatched = ctx.engine.dispatch({
            statement: copyStmt(urlPath("worker", "/note"), urlPath("file", "/parity.txt")),
            workspaceId: ctx.workspaceId,
            workerId: ctx.workerId,
            loopId: ctx.loopId,
            turnId: ctx.turnId,
            sequence: 1,
            origin: "model",
        });

        const live = await observed.promise;
        const reconnect = await ctx.engine.pendingProposals(ctx.workspaceId);
        const { workspaceId, ...liveProjection } = live;
        assert.equal(workspaceId, ctx.workspaceId);
        assert.deepEqual(reconnect, [liveProjection], "live delivery and durable rediscovery are byte-for-byte the same domain projection");
        assert.deepEqual(live.target, { scheme: null, pathname: "parity.txt" }, "COPY review addresses the applied destination, not its source");
        assert.match(live.body, /copied content/, "review body comes from the proposed result rather than serialized statement JSON");
        assert.deepEqual(live.disposition, { owner: "client" });

        ctx.engine.resolveProposal(live.logEntryId, { decision: "reject" });
        await dispatched;
    });
});

test("a scoped COPY into a new file reports the accepted creation receipt", async () => {
    await withWorkspace(async (root, ctx) => {
        await seedWorker(ctx, "note", "alpha\nbeta\ngamma\n");
        const result = await proposeAndResolve(
            ctx,
            copyStmt(
                urlPath("worker", "/note"),
                urlPath("file", "/slice.md"),
                null,
                { marks: [2, 3] },
            ),
            "accept",
        );
        assert.equal(result.status, 200);
        assert.equal(await readFile(join(root, "slice.md"), "utf8"), "beta\ngamma\n");
        assert.ok(Array.isArray(result.effects));
        const [effect] = result.effects as Array<{
            action: string;
            receipt?: {
                before: number;
                after: number;
                effect: { requested: string; context: string };
            };
        }>;
        assert.equal(effect?.action, "create");
        assert.equal(effect?.receipt?.before, 0);
        assert.equal(effect?.receipt?.after, 2);
        assert.equal(effect?.receipt?.effect.requested, "<1,-1>");
        assert.match(effect?.receipt?.effect.context ?? "", /1:beta\n2:gamma/);
    });
});

test("a scoped COPY receipt reports parser recovery for the complete landed file", async () => {
    await withWorkspace(async (root, ctx) => {
        await seedWorker(ctx, "broken.go", "package sample\nfunc broken(\n");
        const result = await proposeAndResolve(
            ctx,
            copyStmt(
                urlPath("worker", "/broken.go"),
                urlPath("file", "/copied.go"),
                null,
                { marks: [1, 2] },
            ),
            "accept",
        );
        assert.equal(result.status, 200);
        const effect = (result.effects as Array<{
            receipt?: { parseIssues?: number };
        }> | undefined)?.[0];
        assert.ok(Number.isSafeInteger(effect?.receipt?.parseIssues) && Number(effect?.receipt?.parseIssues) > 0);
        assert.equal(await readFile(join(root, "copied.go"), "utf8"), "package sample\nfunc broken(\n");
        const entry = await fileMember(ctx, "copied.go");
        const channel = await ctx.db.test_get_channel.get<{ mimetype: string }>({
            entry_id: entry?.id,
            name: "body",
        });
        assert.equal(channel?.mimetype, "text/x-go");
    });
});

test("{§proposal-reject-fails}: a rejected COPY into file:/// never touches disk", async () => {
    await withWorkspace(async (root, ctx) => {
        await seedWorker(ctx, "note", "nope\n");
        const result = await proposeAndResolve(ctx, copyStmt(urlPath("worker", "/note"), urlPath("file", "/rejected.txt")), "reject");
        assert.ok(result.status >= 400, "rejected proposal is a 4xx");
        assert.equal(result.effects, undefined, "a rejected destination proposal lands no effect");
        await assert.rejects(readFile(join(root, "rejected.txt"), "utf8"), "the rejected COPY never created the file");
    });
});

test("a regional COPY into file:/// reports the accepted text receipt", async () => {
    await withWorkspace(async (root, ctx) => {
        await seedWorker(ctx, "note", "alpha\nbeta\ngamma\n");
        await seedFileMember(ctx, root, "destination.md", "before\nreplace\nafter\n");
        const result = await proposeAndResolve(
            ctx,
            copyStmt(
                urlPath("worker", "/note"),
                localPath("destination.md"),
                null,
                { marks: [2] },
                { marks: [2] },
            ),
            "accept",
        );
        assert.equal(result.status, 200);
        assert.equal(await readFile(join(root, "destination.md"), "utf8"), "before\nbeta\nafter\n");
        assert.ok(Array.isArray(result.effects));
        const [effect] = result.effects as Array<{
            target: string;
            action: string;
            receipt?: { effect?: { requested?: string; context?: string } };
        }>;
        assert.equal(effect?.target, "destination.md");
        assert.equal(effect?.action, "update");
        assert.equal(effect?.receipt?.effect?.requested, "<2>");
        assert.match(effect?.receipt?.effect?.context ?? "", /1:before\n2:beta\n3:after/);
    });
});

test("{§move-cross-scheme-move}: accepted MOVE lands the file and deletes the source", async () => {
    await withWorkspace(async (root, ctx) => {
        await seedWorker(ctx, "movee", "moved content\n");
        const result = await proposeAndResolve(ctx, moveStmt(urlPath("worker", "/movee"), urlPath("file", "/moved.txt")), "accept");
        assert.equal(result.status, 200);
        assert.deepEqual(result.effects, [
            { target: "moved.txt", action: "create" },
            { target: "worker:///movee", action: "delete" },
        ]);
        assert.equal(await readFile(join(root, "moved.txt"), "utf8"), "moved content\n");
        assert.equal(await workerEntry(ctx, "movee"), undefined, "MOVE deletes the source on accept");
    });
});

test("a same-file regional MOVE reports both accepted effects from one batch", async () => {
    await withWorkspace(async (root, ctx) => {
        await seedFileMember(ctx, root, "document.md", "abcdef");
        const result = await proposeAndResolve(
            ctx,
            moveStmt(
                localPath("document.md"),
                localPath("document.md"),
                null,
                { marks: [1, 2, 1, 4] },
                { marks: [1, 7, 1, 7] },
            ),
            "accept",
        );
        assert.equal(result.status, 200);
        assert.equal(await readFile(join(root, "document.md"), "utf8"), "adefbc");
        assert.ok(Array.isArray(result.effects));
        const effects = result.effects as Array<{
            target: string;
            action: string;
            receipt?: { effect?: { requested?: string } };
        }>;
        assert.deepEqual(
            effects.map(({ target, action }) => ({ target, action })),
            [
                { target: "document.md", action: "update" },
                { target: "document.md", action: "update" },
            ],
        );
        assert.deepEqual(
            effects.map(({ receipt }) => receipt?.effect?.requested),
            ["<1,7,1,7>", "<1,2,1,4>"],
        );
    });
});

test("a reviewer-rewritten same-file MOVE reports its one landed replacement effect (#172)", async () => {
    await withWorkspace(async (root, ctx) => {
        await seedFileMember(ctx, root, "document.md", "abcdef");
        const reviewed = "reviewer\nreplacement\n";
        const result = await proposeAndResolve(
            ctx,
            moveStmt(
                localPath("document.md"),
                localPath("document.md"),
                null,
                { marks: [1, 2, 1, 4] },
                { marks: [1, 7, 1, 7] },
            ),
            "accept",
            reviewed,
        );

        assert.equal(result.status, 200);
        assert.equal(await readFile(join(root, "document.md"), "utf8"), reviewed);
        assert.ok(Array.isArray(result.effects));
        const effects = result.effects as Array<{
            target: string;
            action: string;
            receipt?: {
                disposition?: string;
                requested?: string;
                replacement?: {
                    requested: string;
                    source: string;
                    result: string;
                    removed: number;
                    inserted: number;
                    context: string;
                };
            };
        }>;
        assert.equal(effects.length, 1, "one arbitrary resource replacement earns one effect");
        assert.deepEqual(
            effects.map(({ target, action }) => ({ target, action })),
            [{ target: "document.md", action: "update" }],
        );
        assert.equal(effects[0]?.receipt?.disposition, "superseded");
        assert.equal(effects[0]?.receipt?.requested, "<1,7,1,7>");
        assert.deepEqual(effects[0]?.receipt?.replacement, {
            requested: "<1,-1>",
            source: "1",
            result: "1-2",
            removed: 1,
            inserted: 2,
            context: "1:reviewer\n2:replacement",
        });
    });
});

test("a reviewer-rewritten cross-resource MOVE still reports its landed source removal (#172)", async () => {
    await withWorkspace(async (root, ctx) => {
        await seedWorker(ctx, "source", "alpha\nbeta\ngamma\n");
        await seedFileMember(ctx, root, "destination.md", "before\nreplace\nafter\n");
        const reviewed = "reviewer\ndestination\n";
        const result = await proposeAndResolve(
            ctx,
            moveStmt(
                urlPath("worker", "/source"),
                localPath("destination.md"),
                null,
                { marks: [2] },
                { marks: [2] },
            ),
            "accept",
            reviewed,
        );

        assert.equal(result.status, 200);
        assert.equal(await readFile(join(root, "destination.md"), "utf8"), reviewed);
        const source = await ctx.db.test_get_channel_by_pathname_scheme.get<{
            content: string;
        }>({ pathname: "/source", scheme: "worker", name: "body" });
        assert.equal(source?.content, "alpha\ngamma\n");
        assert.ok(Array.isArray(result.effects));
        const effects = result.effects as Array<{
            target: string;
            action: string;
            receipt?: {
                disposition?: string;
                requested?: string;
                effect?: { requested?: string };
                replacement?: { context?: string };
            };
        }>;
        assert.deepEqual(
            effects.map(({ target, action }) => ({ target, action })),
            [
                { target: "destination.md", action: "update" },
                { target: "worker:///source", action: "update" },
            ],
        );
        assert.equal(effects[0]?.receipt?.disposition, "superseded");
        assert.equal(effects[0]?.receipt?.requested, "<2>");
        assert.match(effects[0]?.receipt?.replacement?.context ?? "", /1:reviewer\n2:destination/);
        assert.equal(effects[1]?.receipt?.effect?.requested, "<2>");
    });
});

test("{§proposal-reject-fails}: a rejected MOVE into file:/// preserves the source", async () => {
    await withWorkspace(async (_root, ctx) => {
        await seedWorker(ctx, "keepme", "keep\n");
        const result = await proposeAndResolve(ctx, moveStmt(urlPath("worker", "/keepme"), urlPath("file", "/rejected-move.txt")), "reject");
        assert.ok(result.status >= 400, "rejected proposal is a 4xx");
        assert.equal(result.effects, undefined, "a rejected destination proposal lands no effect");
        assert.notEqual(await workerEntry(ctx, "keepme"), undefined, "the source MUST survive a rejected MOVE — the delete was deferred behind the dest write");
    });
});

test("{§move-relocation-deletes-source}: file MOVE into a new subdir lands and unlinks", async () => {
    // The file→file MOVE that was a silent noop: File lacked deleteEntry, so #handleMove returned a
    // bare 501 before any write — the model's correct MOVE did nothing while the worker concluded 200.
    await withWorkspace(async (root, ctx) => {
        await seedFileMember(ctx, root, "brief.md", "the brief\n");
        // BARE paths — exactly what the model emits (`MOVE(brief.md):drafts/brief.md`). The source
        // read must normalize `brief.md` → the `/brief.md` member key, or it 404s a real member.
        const result = await proposeAndResolve(ctx, moveStmt(localPath("brief.md"), localPath("drafts/brief.md")), "accept");
        assert.equal(result.status, 200);
        assert.deepEqual(result.effects, [
            { target: "drafts/brief.md", action: "create" },
            { target: "brief.md", action: "delete" },
        ]);
        assert.equal(await readFile(join(root, "drafts/brief.md"), "utf8"), "the brief\n", "dest written into the freshly-created subdir");
        await assert.rejects(readFile(join(root, "brief.md"), "utf8"), "source file unlinked — a MOVE, not a COPY");
        assert.equal(await fileMember(ctx, "brief.md"), undefined, "source entry deregistered");
    });
});

test("{§move-canonical-whole-source}: file MOVE with <1,-1> unlinks rather than hollows the source", async () => {
    await withWorkspace(async (root, ctx) => {
        await seedFileMember(ctx, root, "brief.md", "the brief\n");
        const result = await proposeAndResolve(
            ctx,
            moveStmt(localPath("brief.md"), localPath("drafts/brief.md"), null, fullReplace),
            "accept",
        );
        assert.equal(result.status, 200);
        assert.deepEqual(result.effects, [
            { target: "drafts/brief.md", action: "create" },
            { target: "brief.md", action: "delete" },
        ]);
        assert.equal(await readFile(join(root, "drafts/brief.md"), "utf8"), "the brief\n");
        await assert.rejects(readFile(join(root, "brief.md"), "utf8"), "the canonical whole-content MOVE unlinks its source");
        assert.equal(await fileMember(ctx, "brief.md"), undefined, "the source member is deregistered");
    });
});

test("MOVE file:/// to an internal destination applies the source proposal after the destination lands", async () => {
    await withWorkspace(async (root, ctx) => {
        await seedFileMember(ctx, root, "source.md", "source content\n");
        const result = await proposeAndResolve(
            ctx,
            moveStmt(localPath("source.md"), urlPath("worker", "/moved")),
            "accept",
        );
        assert.equal(result.status, 200);
        assert.deepEqual(result.effects, [
            { target: "worker:///moved", action: "create" },
            { target: "source.md", action: "delete" },
        ]);
        assert.notEqual(await workerEntry(ctx, "moved"), undefined);
        await assert.rejects(readFile(join(root, "source.md"), "utf8"));
        assert.equal(await fileMember(ctx, "source.md"), undefined);
    });
});

test("rejecting a source-side MOVE proposal reports the already-written destination without deleting the source", async () => {
    await withWorkspace(async (root, ctx) => {
        await seedFileMember(ctx, root, "source.md", "source content\n");
        const result = await proposeAndResolve(
            ctx,
            moveStmt(localPath("source.md"), urlPath("worker", "/copied")),
            "reject",
        );
        assert.equal(result.status, 409);
        assert.equal(result.problem?.destinationWritten, true);
        assert.equal(result.problem?.destination, "worker:///copied");
        assert.deepEqual(result.effects, [{
            target: "worker:///copied",
            action: "create",
        }]);
        assert.notEqual(await workerEntry(ctx, "copied"), undefined);
        assert.equal(await readFile(join(root, "source.md"), "utf8"), "source content\n");
        assert.notEqual(await fileMember(ctx, "source.md"), undefined);
    });
});

test("EDIT onto an existing NON-member file is refused (403) and never clobbers it", async () => {
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
        assert.equal(result.problem?.type, "https://problems.plurnk.dev/scheme/file/entry-not-found");
        assert.equal(result.problem?.detail, "No file entry exists at untracked.txt.");
        assert.equal(await readFile(join(root, "untracked.txt"), "utf8"), "not yours\n", "the untracked file is untouched");
    });
});
