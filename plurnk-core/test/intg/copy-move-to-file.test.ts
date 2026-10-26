// COPY/MOVE into files — a disk write under {§copy-cross-scheme-copy},
// {§move-cross-scheme-move}, and the {§proposal} gate.
// The dest write proposes (202); on accept the file lands + an entry registers.
// MOVE's source-delete is DEFERRED to after the accept, so a rejected MOVE leaves
// the source intact (no data loss behind a pending review).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import Engine from "../../src/core/Engine.ts";
import type { ProposalPendingEvent } from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { ownSession } from "./_approval.ts";
import Workspace from "../../src/schemes/Workspace.ts";
import type { Db } from "../../src/core/Db.ts";
import type { ParsedPath, KillStatement } from "@plurnk/plurnk-contracts";
import { openMigrated, insertWorkspace, insertSession, insertLoop, insertTurn, seedEntryWithChannel } from "./_db.ts";
import { makeSchemeCtx, DEFAULT_MIMETYPES } from "./_scheme.ts";
import MembershipMaterialization from "../../src/core/MembershipMaterialization.ts";
import { assertResourceEffects } from "../../src/content/index.ts";
import { urlPath, localPath, editStmt, copyStmt, moveStmt, fullReplace } from "./_dsl.ts";

const deferred = <T>(): { promise: Promise<T>; resolve: (v: T) => void } => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
};

type Ctx = { db: Db; engine: Engine; workspaceId: number; sessionId: number; loopId: number; turnId: number };

const withWorkspace = async (fn: (root: string, ctx: Ctx) => Promise<void>): Promise<void> => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-cpmv-"));
    const db = await openMigrated();
    try {
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES, weigh: (t: string) => Math.ceil(t.length / 4) });
        const workspaceId = await insertWorkspace(db, `cpmv-${crypto.randomUUID()}`);
        await db.test_set_workspace_project_root.run({ id: workspaceId, project_root: root });
        const sessionId = await insertSession(db, workspaceId);
        await ownSession(db, workspaceId, sessionId);
        const loopId = await insertLoop(db, sessionId, 1, "cpmv");
        const turnId = await insertTurn(db, loopId, 1, 102);
        await fn(root, { db, engine, workspaceId, sessionId, loopId, turnId });
    } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
};

const seedSession = (ctx: Ctx, pathname: string, content: string) =>
    new Workspace().edit(editStmt(urlPath("workspace", `/${pathname}`), content), makeSchemeCtx({ db: ctx.db, workspaceId: ctx.workspaceId, sessionId: ctx.sessionId }));

const sessionEntry = (ctx: Ctx, pathname: string) =>
    ctx.db.test_get_entry_by_pathname_scheme.get<{ pathname: string }>({ pathname: `/${pathname}`, scheme: "workspace" });

// {§file-snapshot-revision}: materialize through the production snapshot owner.
const seedFileMember = async (ctx: Ctx, root: string, rel: string, content: string): Promise<void> => {
    const abs = join(root, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
    await ctx.db.test_seed_entry_workspace.get({ attributes: "{}", default_channel: "body", output: 0, workspace_id: ctx.workspaceId, scheme: "file", authority: "", pathname: rel });
    await MembershipMaterialization.materializeMember(rel, root, makeSchemeCtx({ ...ctx, mimetypes: DEFAULT_MIMETYPES }), new Map());
};

const fileMember = async (ctx: Ctx, rel: string) =>
    ctx.db.crud_find_workspace_entry.get<{ id: number }>({ workspace_id: ctx.workspaceId, scheme: "file", authority: "", pathname: rel });

const generatedPicks = (ctx: Ctx) =>
    ctx.db.crud_list_workspace_constraints.all<{ effect: string; glob: string; source: string }>({ workspace_id: ctx.workspaceId });

const killStmt = (target: ParsedPath): KillStatement => ({ metadata: null, op: "KILL", aside: null, target, lineMarker: null, matcher: null, body: null, position: { line: 1, column: 1 } });

const proposeAndResolve = async (
    ctx: Ctx,
    statement: Parameters<Engine["dispatch"]>[0]["statement"],
    decision: "accept" | "reject",
    body?: string,
) => {
    const id = deferred<number>();
    const dispatchPromise = ctx.engine.dispatch({
        statement, workspaceId: ctx.workspaceId, sessionId: ctx.sessionId, loopId: ctx.loopId, turnId: ctx.turnId,
        sequence: 1, origin: "model", onDispatch: (logId) => id.resolve(logId),
    });
    const logEntryId = await id.promise;
    if (!ctx.engine.pendingProposalIds().includes(logEntryId)) assert.fail(`Expected a proposal, received ${JSON.stringify(await dispatchPromise)}`);
    ctx.engine.resolveProposal(logEntryId, {
        decision,
        ...(body === undefined ? {} : { body }),
    });
    return dispatchPromise;
};

test("{§fs-create-copy} {§copy-cross-scheme-copy}: COPY workspace:/// → file proposes then lands on accept", async () => {
    await withWorkspace(async (root, ctx) => {
        await seedSession(ctx, "note", "copied content\n");
        const result = await proposeAndResolve(ctx, copyStmt(urlPath("workspace", "/note"), localPath("copied.txt")), "accept");
        assert.equal(result.status, 200);
        assert.deepEqual(result.effects, [{
            target: "copied.txt",
            action: "create",
        }]);
        assert.equal(await readFile(join(root, "copied.txt"), "utf8"), "copied content\n");
        assert.notEqual(await sessionEntry(ctx, "note"), undefined, "COPY leaves the source intact");
        assert.deepEqual(await generatedPicks(ctx), [
            { effect: "include", glob: "copied.txt", source: "create" },
        ], "COPY destination creation uses the ordinary generated-pick contract");
    });
});

for (const transfer of [copyStmt, moveStmt]) {
    const op = transfer(urlPath("workspace", "/note"), localPath("copied.txt")).op;
    for (const decision of ["accept", "reject"] as const) {
        test(`{§mimetype-verbatim-transfer}: ${op} plain text to a file respects ${decision} before changing either resource`, async () => {
            await withWorkspace(async (root, ctx) => {
                const content = "## Result\r\n\t<verbatim> café\r\n";
                await seedEntryWithChannel(ctx.db, { workspaceId: ctx.workspaceId, pathname: "/note", content, mimetype: "text/plain" });
                const result = await proposeAndResolve(ctx, transfer(urlPath("workspace", "/note"), localPath("copied.txt")), decision);
                if (decision === "accept") {
                    assert.equal(result.status, 200);
                    assert.equal(await readFile(join(root, "copied.txt"), "utf8"), content);
                    const destination = await ctx.db.test_get_channel_by_pathname_scheme.get<{ mimetype: string }>({ scheme: "file", pathname: "copied.txt", name: "body" });
                    assert.equal(destination?.mimetype, "text/markdown");
                } else {
                    assert.equal(result.status, 400);
                    assert.equal(result.problem?.type, "https://problems.plurnk.xyz/proposal/rejected");
                    await assert.rejects(readFile(join(root, "copied.txt")), { code: "ENOENT" });
                }
                const source = await ctx.db.test_get_channel_by_pathname_scheme.get<{ content: string; mimetype: string }>({ scheme: "workspace", pathname: "/note", name: "body" });
                if (op === "MOVE" && decision === "accept") assert.equal(source, undefined);
                else {
                    assert.equal(source?.content, content);
                    assert.equal(source?.mimetype, "text/plain");
                }
            });
        });
    }
}

test("{§notifications-loop-proposal} live and reconnect use one COPY destination proposal projection", async () => {
    await withWorkspace(async (_root, ctx) => {
        await seedSession(ctx, "note", "copied content\n");
        const observed = deferred<ProposalPendingEvent>();
        ctx.engine.onProposalPending((event) => observed.resolve(event));
        const dispatched = ctx.engine.dispatch({
            statement: copyStmt(urlPath("workspace", "/note"), localPath("parity.txt")),
            workspaceId: ctx.workspaceId,
            sessionId: ctx.sessionId,
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
        assert.deepEqual(live.target, { scheme: null, authority: "", pathname: "parity.txt" }, "COPY review addresses the applied destination, not its source");
        assert.match(live.body, /copied content/, "review body comes from the proposed result rather than serialized statement JSON");
        assert.deepEqual(live.disposition, { decision: "review" });

        ctx.engine.resolveProposal(live.logEntryId, { decision: "reject" });
        await dispatched;
    });
});

test("{§copy-cross-scheme-copy} a scoped COPY into a new file reports the accepted creation receipt", async () => {
    await withWorkspace(async (root, ctx) => {
        await seedSession(ctx, "note", "alpha\nbeta\ngamma\n");
        const result = await proposeAndResolve(
            ctx,
            copyStmt(
                urlPath("workspace", "/note"),
                localPath("slice.md"),
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
        assert.match(effect?.receipt?.effect.context ?? "", /1<@[0-9A-Za-z]{5}>beta\n2<@[0-9A-Za-z]{5}>gamma/);
    });
});

test("{§copy-cross-scheme-copy} a scoped COPY receipt reports parser recovery for the complete landed file", async () => {
    await withWorkspace(async (root, ctx) => {
        await seedSession(ctx, "broken.go", "package sample\nfunc broken(\n");
        const result = await proposeAndResolve(
            ctx,
            copyStmt(
                urlPath("workspace", "/broken.go"),
                localPath("copied.go"),
                { marks: [1, 2] },
            ),
            "accept",
        );
        assert.equal(result.status, 200);
        const effect = (result.effects as Array<{
            receipt?: { parseIssues?: { before: number; after: number } };
        }> | undefined)?.[0];
        assert.equal(effect?.receipt?.parseIssues?.before, 0);
        assert.ok(Number.isSafeInteger(effect?.receipt?.parseIssues?.after));
        assert.ok((effect?.receipt?.parseIssues?.after ?? 0) > 0);
        assert.equal(await readFile(join(root, "copied.go"), "utf8"), "package sample\nfunc broken(\n");
        const entry = await fileMember(ctx, "copied.go");
        const channel = await ctx.db.test_get_channel.get<{ mimetype: string }>({
            entry_id: entry?.id,
            name: "body",
        });
        assert.equal(channel?.mimetype, "text/x-go");
    });
});

test("{§proposal-reject-fails}: a rejected COPY into a file never touches disk", async () => {
    await withWorkspace(async (root, ctx) => {
        await seedSession(ctx, "note", "nope\n");
        const result = await proposeAndResolve(ctx, copyStmt(urlPath("workspace", "/note"), localPath("rejected.txt")), "reject");
        assert.ok(result.status >= 400, "rejected proposal is a 4xx");
        assert.equal(result.effects, undefined, "a rejected destination proposal lands no effect");
        await assert.rejects(readFile(join(root, "rejected.txt"), "utf8"), "the rejected COPY never created the file");
    });
});

test("{§copy-cross-scheme-copy} a regional COPY into a file reports the accepted text receipt", async () => {
    await withWorkspace(async (root, ctx) => {
        await seedSession(ctx, "note", "alpha\nbeta\ngamma\n");
        await seedFileMember(ctx, root, "destination.md", "before\nreplace\nafter\n");
        const result = await proposeAndResolve(
            ctx,
            copyStmt(
                urlPath("workspace", "/note"),
                localPath("destination.md"),
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
        assert.match(effect?.receipt?.effect?.context ?? "", /1<@[0-9A-Za-z]{5}>before\n2<@[0-9A-Za-z]{5}>beta\n3<@[0-9A-Za-z]{5}>after/);
    });
});

test("{§move-cross-scheme-move}: accepted MOVE lands the file and deletes the source", async () => {
    await withWorkspace(async (root, ctx) => {
        await seedSession(ctx, "movee", "moved content\n");
        const result = await proposeAndResolve(ctx, moveStmt(urlPath("workspace", "/movee"), localPath("moved.txt")), "accept");
        assert.equal(result.status, 200);
        assert.deepEqual(result.effects, [
            { target: "moved.txt", action: "create" },
            { target: "workspace:///movee", action: "delete" },
        ]);
        assert.equal(await readFile(join(root, "moved.txt"), "utf8"), "moved content\n");
        assert.equal(await sessionEntry(ctx, "movee"), undefined, "MOVE deletes the source on accept");
    });
});

test("{§copy-cross-scheme-copy} a same-file regional MOVE reports both accepted effects from one batch", async () => {
    await withWorkspace(async (root, ctx) => {
        await seedFileMember(ctx, root, "document.md", "abcdef");
        const result = await proposeAndResolve(
            ctx,
            moveStmt(
                localPath("document.md"),
                localPath("document.md"),
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

test("{§copy-cross-scheme-copy} a reviewer-rewritten same-file MOVE reports its one landed replacement effect (#172)", async () => {
    await withWorkspace(async (root, ctx) => {
        await seedFileMember(ctx, root, "document.md", "abcdef");
        const reviewed = "reviewer\nreplacement\n";
        const result = await proposeAndResolve(
            ctx,
            moveStmt(
                localPath("document.md"),
                localPath("document.md"),
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
        const { context: landedContext, ...landed } = effects[0]?.receipt?.replacement ?? {};
        assert.deepEqual(landed, { requested: "<1,-1>", source: "<1>", result: "<1,2>", removed: 1, inserted: 2 });
        assert.match(String(landedContext), /^1<@[0-9A-Za-z]{5}>reviewer\n2<@[0-9A-Za-z]{5}>replacement$/);
    });
});

test("{§copy-cross-scheme-copy} a reviewer-rewritten cross-resource MOVE still reports its landed source removal (#172)", async () => {
    await withWorkspace(async (root, ctx) => {
        await seedSession(ctx, "source", "alpha\nbeta\ngamma\n");
        await seedFileMember(ctx, root, "destination.md", "before\nreplace\nafter\n");
        const reviewed = "reviewer\ndestination\n";
        const result = await proposeAndResolve(
            ctx,
            moveStmt(
                urlPath("workspace", "/source"),
                localPath("destination.md"),
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
        }>({ pathname: "/source", scheme: "workspace", name: "body" });
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
                { target: "workspace:///source", action: "update" },
            ],
        );
        assert.equal(effects[0]?.receipt?.disposition, "superseded");
        assert.equal(effects[0]?.receipt?.requested, "<2>");
        assert.match(effects[0]?.receipt?.replacement?.context ?? "", /1<@[0-9A-Za-z]{5}>reviewer\n2<@[0-9A-Za-z]{5}>destination/);
        assert.equal(effects[1]?.receipt?.effect?.requested, "<2>");
    });
});

test("{§proposal-reject-fails}: a rejected MOVE into a file preserves the source", async () => {
    await withWorkspace(async (_root, ctx) => {
        await seedSession(ctx, "keepme", "keep\n");
        const result = await proposeAndResolve(ctx, moveStmt(urlPath("workspace", "/keepme"), localPath("rejected-move.txt")), "reject");
        assert.ok(result.status >= 400, "rejected proposal is a 4xx");
        assert.equal(result.effects, undefined, "a rejected destination proposal lands no effect");
        assert.notEqual(await sessionEntry(ctx, "keepme"), undefined, "the source MUST survive a rejected MOVE — the delete was deferred behind the dest write");
    });
});

test("{§fs-create-move} {§move-relocation-deletes-source}: file MOVE into a new subdir lands and unlinks", async () => {
    // The file→file MOVE that was a silent noop: File lacked deleteEntry, so #handleMove returned a
    // bare 501 before any write — the model's correct MOVE did nothing while the session concluded 200.
    await withWorkspace(async (root, ctx) => {
        await seedFileMember(ctx, root, "brief.md", "the brief\n");
        const source = await fileMember(ctx, "brief.md");
        await ctx.db.crud_set_origin.run({ entry_id: source?.id, membership_origin: "constraint" });
        await ctx.db.crud_insert_generated_workspace_constraint.run({ workspace_id: ctx.workspaceId, glob: "brief.md" });
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
        assert.deepEqual(await generatedPicks(ctx), [
            { effect: "include", glob: "drafts/brief.md", source: "create" },
        ], "MOVE transfers generated creation provenance from source to destination");
    });
});

test("{§move-canonical-whole-source}: file MOVE with <1,-1> to absent <0> unlinks rather than hollows the source", async () => {
    await withWorkspace(async (root, ctx) => {
        await seedFileMember(ctx, root, "brief.md", "the brief\n");
        const result = await proposeAndResolve(
            ctx,
            moveStmt(localPath("brief.md"), localPath("drafts/brief.md"), fullReplace, { marks: [0] }),
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

test("{§move-decomposition} MOVE from a file to an internal destination applies the source proposal after the destination lands", async () => {
    await withWorkspace(async (root, ctx) => {
        await seedFileMember(ctx, root, "source.md", "source content\n");
        const result = await proposeAndResolve(
            ctx,
            moveStmt(localPath("source.md"), urlPath("workspace", "/moved")),
            "accept",
        );
        assert.equal(result.status, 200);
        assert.deepEqual(result.effects, [
            { target: "workspace:///moved", action: "create" },
            { target: "source.md", action: "delete" },
        ]);
        assert.notEqual(await sessionEntry(ctx, "moved"), undefined);
        await assert.rejects(readFile(join(root, "source.md"), "utf8"));
        assert.equal(await fileMember(ctx, "source.md"), undefined);
    });
});

for (const destinationKind of ["file", "session"] as const) {
    for (const scoped of [false, true]) {
        test(`{§move-decomposition} MOVE ${scoped ? "regional" : "whole"} file source to ${destinationKind} applies both effects`, async () => {
            await withWorkspace(async (root, ctx) => {
                await seedFileMember(ctx, root, "source.md", "keep\nmove\n");
                const statement = moveStmt(
                    localPath("source.md"),
                    destinationKind === "file" ? localPath("destination.md") : urlPath("workspace", "/destination"),
                    scoped ? { marks: [2] } : null,
                );
                const result = await proposeAndResolve(ctx, statement, "accept");
                assert.equal(result.status, 200, JSON.stringify(result));
                assert.deepEqual(assertResourceEffects(result.effects).map(({ target, action }) => ({ target, action })), [
                    { target: destinationKind === "file" ? "destination.md" : "workspace:///destination", action: "create" },
                    { target: "source.md", action: scoped ? "update" : "delete" },
                ]);
                if (scoped) assert.equal(await readFile(join(root, "source.md"), "utf8"), "keep\n");
                else await assert.rejects(readFile(join(root, "source.md")), { code: "ENOENT" });
                const expected = scoped ? "move\n" : "keep\nmove\n";
                if (destinationKind === "file") assert.equal(await readFile(join(root, "destination.md"), "utf8"), expected);
                else assert.equal((await ctx.db.test_get_channel_by_pathname_scheme.get<{ content: string }>({
                    pathname: "/destination", scheme: "workspace", name: "body",
                }))?.content, expected);
            });
        });
    }
}

test("{§copy-cross-scheme-copy} rejecting a source-side MOVE proposal reports the already-written destination without deleting the source", async () => {
    await withWorkspace(async (root, ctx) => {
        await seedFileMember(ctx, root, "source.md", "source content\n");
        const result = await proposeAndResolve(
            ctx,
            moveStmt(localPath("source.md"), urlPath("workspace", "/copied")),
            "reject",
        );
        assert.equal(result.status, 409);
        assert.equal(result.problem?.destinationWritten, true);
        assert.equal(result.problem?.destination, "workspace:///copied");
        assert.deepEqual(result.effects, [{
            target: "workspace:///copied",
            action: "create",
        }]);
        assert.notEqual(await sessionEntry(ctx, "copied"), undefined);
        assert.equal(await readFile(join(root, "source.md"), "utf8"), "source content\n");
        assert.notEqual(await fileMember(ctx, "source.md"), undefined);
    });
});

test("{§copy-cross-scheme-copy} EDIT onto an existing NON-member file is refused (403) and never clobbers it", async () => {
    // The unfair edge: a file exists on disk but was never tracked (git/client left it out), so it's
    // INVISIBLE to the model. The model, blind to it, tries to "create" it — and MUST NOT be able to
    // overwrite it. The refusal is opaque (never reveals the file exists) so the model can't probe the
    // untracked filesystem by watching which creates fail.
    await withWorkspace(async (root, ctx) => {
        await writeFile(join(root, "AGENTS.md"), "SECRET untracked policy\n", "utf8"); // on disk, NOT a member
        // A refused create returns 403 outright — it never PROPOSES (no review to accept), so dispatch directly.
        const result = await ctx.engine.dispatch({
            statement: editStmt(localPath("AGENTS.md"), "# the model's clobbering content"),
            workspaceId: ctx.workspaceId, sessionId: ctx.sessionId, loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
        });
        assert.equal(result.status, 403, "create over an existing non-member is refused outright, never a proposal, never clobbered");
        assert.equal(await readFile(join(root, "AGENTS.md"), "utf8"), "SECRET untracked policy\n", "the untracked file is untouched");
    });
});

test("{§copy-cross-scheme-copy} KILL of a file is a destructive host delete → it PROPOSES; on accept the file is unlinked + deregistered", async () => {
    await withWorkspace(async (root, ctx) => {
        await seedFileMember(ctx, root, "doomed.txt", "delete me\n");
        const result = await proposeAndResolve(ctx, killStmt(localPath("doomed.txt")), "accept");
        assert.equal(result.status, 200, "KILL proposed for review, then applied on accept");
        await assert.rejects(readFile(join(root, "doomed.txt"), "utf8"), "the host file was unlinked");
        assert.equal(await fileMember(ctx, "doomed.txt"), undefined, "the entry was deregistered");
    });
});

test("{§copy-cross-scheme-copy} a REJECTED KILL of a file preserves it — a destructive delete never bypasses review", async () => {
    await withWorkspace(async (root, ctx) => {
        await seedFileMember(ctx, root, "keep.txt", "keep me\n");
        const result = await proposeAndResolve(ctx, killStmt(localPath("keep.txt")), "reject");
        assert.ok(result.status >= 400, "rejected proposal is a 4xx");
        assert.equal(await readFile(join(root, "keep.txt"), "utf8"), "keep me\n", "the file survives — review gates the destructive op, never a silent unlink");
    });
});

test("{§fs-write-surface} KILL of a NON-member file is 404 — the model can't delete untracked disk it can't see", async () => {
    await withWorkspace(async (root, ctx) => {
        await writeFile(join(root, "untracked.txt"), "not yours\n", "utf8"); // on disk, NOT a member
        const result = await ctx.engine.dispatch({
            statement: killStmt(localPath("untracked.txt")),
            workspaceId: ctx.workspaceId, sessionId: ctx.sessionId, loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
        });
        assert.equal(result.status, 404, "a non-member KILL is 404 — invisible, never touched");
        assert.equal(result.problem?.type, "https://problems.plurnk.xyz/scheme/file/entry-not-found");
        assert.equal(result.problem?.detail, "No member of this workspace is at 'untracked.txt'.");
        assert.equal(await readFile(join(root, "untracked.txt"), "utf8"), "not yours\n", "the untracked file is untouched");
    });
});

// {§fs-write-surface} {§empty-mutation-scope}
test("{§fs-write-surface}: COPY destination scopes resolve against an empty absent entry", async () => {
    await withWorkspace(async (_root, ctx) => {
        const source = "first prompt\nsecond prompt\nthird prompt\n";
        await seedSession(ctx, "note", source);
        type DestinationMarker = NonNullable<Parameters<typeof copyStmt>[3]>;
        let sequence = 0;
        const dispatch = (dst: string, marker: DestinationMarker | null) => ctx.engine.dispatch({
            statement: copyStmt(urlPath("workspace", "/note"), urlPath("workspace", dst), null, marker),
            workspaceId: ctx.workspaceId, sessionId: ctx.sessionId, loopId: ctx.loopId, turnId: ctx.turnId, sequence: ++sequence, origin: "model",
        });

        const cases = [
            ["prepend.md", [0]],
            ["first-line.md", [1]],
            ["append.md", [-1]],
            ["whole.md", [1, -1]],
            ["clamped.md", [1, 50]],
            ["exact.md", [1, 1, 1, 1]],
        ] as const;
        for (const [pathname, marks] of cases) {
            const created = await dispatch(`/${pathname}`, { marks: [...marks] });
            assert.equal(created.status, 201, `<${marks.join(",")}> creates an absent destination`);
            const entry = await ctx.db.test_get_channel_by_pathname_scheme.get<{ content: string }>({ pathname: `/${pathname}`, scheme: "workspace", name: "body" });
            assert.equal(entry?.content, source, `<${marks.join(",")}> applies the source to the empty destination`);
        }

        await seedSession(ctx, "empty.md", "");
        const intoEmpty = await dispatch("/empty.md", { marks: [1] });
        assert.equal(intoEmpty.status, 200);
        const emptyDestination = await ctx.db.test_get_channel_by_pathname_scheme.get<{ content: string }>({ pathname: "/empty.md", scheme: "workspace", name: "body" });
        assert.equal(emptyDestination?.content, source, "an existing empty destination uses the same coordinate rule");

        const appended = await dispatch("/append.md", { marks: [-1] });
        assert.equal(appended.status, 200);
        const twice = await ctx.db.test_get_channel_by_pathname_scheme.get<{ content: string }>({ pathname: "/append.md", scheme: "workspace", name: "body" });
        assert.equal(twice?.content, source + source, "the second COPY appends after the last line");

        const outsideEmptyDestination = await dispatch("/absent.md", { marks: [2] });
        assert.equal(outsideEmptyDestination.status, 416, "a coordinate outside the empty destination remains unsatisfiable");
        assert.equal(outsideEmptyDestination.problem?.type, "https://problems.plurnk.xyz/schemes/slicer/range-not-satisfiable");
        assert.match(outsideEmptyDestination.problem?.detail ?? "", /Line 2 cannot select from empty content/);
        assert.equal(await sessionEntry(ctx, "absent.md"), undefined);
    });
});

test("{§fs-write-surface}: MOVE <0> onto an absent session entry creates it and removes the source", async () => {
    await withWorkspace(async (_root, ctx) => {
        await seedSession(ctx, "brief.md", "the brief\n");
        const result = await ctx.engine.dispatch({
            statement: moveStmt(
                urlPath("workspace", "/brief.md"),
                urlPath("workspace", "/drafts/brief.md"),
                { marks: [1, -1] },
                { marks: [0] },
            ),
            workspaceId: ctx.workspaceId,
            sessionId: ctx.sessionId,
            loopId: ctx.loopId,
            turnId: ctx.turnId,
            sequence: 1,
            origin: "model",
        });

        assert.equal(result.status, 201);
        const destination = await ctx.db.test_get_channel_by_pathname_scheme.get<{ content: string }>({ pathname: "/drafts/brief.md", scheme: "workspace", name: "body" });
        assert.equal(destination?.content, "the brief\n");
        assert.equal(await sessionEntry(ctx, "brief.md"), undefined, "MOVE removes its source after destination creation succeeds");
    });
});

test("{§fs-write-surface}: an impossible destination scope refuses MOVE before any write or source removal", async () => {
    await withWorkspace(async (root, ctx) => {
        await seedSession(ctx, "source.md", "keep this\n");
        const result = await ctx.engine.dispatch({
            statement: moveStmt(urlPath("workspace", "/source.md"), localPath("missing.md"), null, { marks: [37] }),
            workspaceId: ctx.workspaceId,
            sessionId: ctx.sessionId,
            loopId: ctx.loopId,
            turnId: ctx.turnId,
            sequence: 1,
            origin: "model",
        });
        assert.equal(result.status, 416);
        assert.equal(result.problem?.type, "https://problems.plurnk.xyz/schemes/slicer/range-not-satisfiable");
        assert.match(result.problem?.detail ?? "", /Line 37 cannot select from empty content/);
        const source = await ctx.db.test_get_channel_by_pathname_scheme.get<{ content: string }>({ pathname: "/source.md", scheme: "workspace", name: "body" });
        assert.equal(source?.content, "keep this\n");
        await assert.rejects(readFile(join(root, "missing.md")), { code: "ENOENT" });
        assert.equal(await fileMember(ctx, "missing.md"), undefined);
        assert.deepEqual(await ctx.engine.pendingProposals(ctx.workspaceId), []);
    });
});
