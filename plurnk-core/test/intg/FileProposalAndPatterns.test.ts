import test, { describe } from "node:test";
import assert from "node:assert/strict";
import Workspace from "../../src/schemes/Workspace.ts";
import Engine from "../../src/core/Engine.ts";
import Turn from "../../src/core/Turn.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import EntryScheme from "./_entry-scheme.ts";
import LineAnchors from "../../src/content/line-anchors.ts";
import TurnOps from "../../src/core/TurnOps.ts";
import File from "../../src/schemes/File.ts";
import MembershipMaterialization from "../../src/core/MembershipMaterialization.ts";
import EntryCrud from "../../src/schemes/_entry-crud.ts";
import PacketWire from "../../src/core/packet-wire.ts";
import { type LineMarker, type ReadStatement, type EditStatement, type MatcherBody, type PlurnkStatement } from "@plurnk/plurnk-contracts";
import { InvalidOperationResultError } from "@plurnk/plurnk-schemes";
import { openMigrated, insertWorkspace, insertSession, seedEnvelope, insertLoop, insertTurn } from "./_db.ts";
import { makeSchemeCtx, DEFAULT_MIMETYPES } from "./_scheme.ts";
import { urlPath, fullReplace, copyStmt, moveStmt, localPath, editStmt } from "./_dsl.ts";
import { serverProposals, ownSession } from "./_approval.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm, readFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mock } from "@plurnk/plurnk-providers";
import { hermeticGitEnv } from "../../src/core/git-env.ts";
import { rpcCall, connect, withDaemon, runLoopToTerminal, subscribeNotifications, waitFor } from "./_rpc.ts";
import { makeMockResponse, fixtureExecutors } from "./_mock.ts";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { createHash } from "node:crypto";
import { type Db } from "../../src/core/Db.ts";
import { type PlurnkSchemeContext } from "../../src/core/scheme-types.ts";
import { clientRead } from "./_client-read.ts";


describe("File.reviewed-batch", () => {
const execFileP = promisify(execFile);

test("{§capability-ctx} {§edit-result-receipt-projection} {§op-methods-op-dispatch}: reviewer replacement supersedes only its EDIT; the next scope addresses the landed content", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-reviewed-batch-"));
    try {
        await execFileP("git", ["init", "-q"], { cwd: root, env: hermeticGitEnv() });
        await execFileP("git", ["config", "user.email", "fixture@plurnk.invalid"], { cwd: root, env: hermeticGitEnv() });
        await execFileP("git", ["config", "user.name", "fixture"], { cwd: root, env: hermeticGitEnv() });
        await writeFile(join(root, "reviewed.md"), "one\ntwo\nthree\nfour\n");
        await execFileP("git", ["add", "reviewed.md"], { cwd: root, env: hermeticGitEnv() });
        await execFileP(
            "git",
            ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--no-verify", "-q", "-m", "seed"],
            { cwd: root, env: hermeticGitEnv() },
        );

        const mock = new Mock({
            contextWindow: 32768,
            responses: [makeMockResponse(
                "````EDIT (reviewed.md) <2>\nTWO\n````\n"
                + "````EDIT (reviewed.md) <4>\nFOUR\n````\n"
                + "````SEND\ndone\n````",
                20,
            ), makeMockResponse("````SEND [200]\ndone\n````", 10)], // {§loop-completion} — the edit receipts force the second turn
        });
        const reviewed = "reviewer\nreplacement\n";
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                const proposals = subscribeNotifications(ws, "loop/proposal");
                const terminated = subscribeNotifications(ws, "loop/terminated");
                await rpcCall(ws, 1, "workspace.create", {
                    name: `reviewed-batch-${crypto.randomUUID()}`,
                    projectRoot: root,
                });
                const started = await rpcCall(ws, 2, "loop.run", { prompt: "edit the file" });
                const loopId = (started.result as { loopId: number }).loopId;
                const pending = await waitFor(
                    () => proposals() as Array<{ logEntryId: number; op: string }>,
                    (items) => items.some((item) => item.op === "EDIT"),
                );
                const proposal = pending.find((item) => item.op === "EDIT");
                assert.ok(proposal !== undefined);
                await rpcCall(ws, 3, "loop.resolve", {
                    logEntryId: proposal.logEntryId,
                    decision: "accept",
                    body: reviewed,
                });
                await waitFor(
                    () => terminated() as Array<{ loopId: number }>,
                    (items) => items.some((item) => item.loopId === loopId),
                );

                assert.equal(await readFile(join(root, "reviewed.md"), "utf8"), reviewed);
                const rows = await db.test_log_entries_by_loop.all<{
                    op: string;
                    origin: string;
                    tx: string;
                    rx: string;
                }>({ loop_id: loopId });
                const edits = rows
                    .filter((row) => row.op === "EDIT" && row.origin === "model")
                    .map((row) => ({
                        tx: JSON.parse(row.tx) as { lineMarker?: { marks?: number[] } },
                        rx: JSON.parse(row.rx) as {
                            status: number;
                            editReceipt?: unknown;
                            receipt?: {
                                revision?: string;
                                disposition?: string;
                                requested?: string;
                                replacement?: {
                                    requested?: string;
                                    source?: string;
                                    result?: string;
                                    context?: string;
                                };
                            };
                        },
                    }));
                assert.equal(edits.length, 2);
                assert.deepEqual(edits.map(({ tx }) => tx.lineMarker?.marks), [[2], [4]]);
                assert.deepEqual(edits.map(({ rx }) => rx.status), [200, 416], "the second EDIT independently rejects line 4 of the two-line replacement");
                assert.deepEqual(
                    edits.map(({ rx }) => ({
                        disposition: rx.receipt?.disposition,
                        requested: rx.receipt?.requested,
                    })),
                    [
                        { disposition: "superseded", requested: "<2>" },
                        { disposition: undefined, requested: undefined },
                    ],
                );
                const { context: replacementContext, ...replacement } = edits[0]?.rx.receipt?.replacement ?? {};
                assert.deepEqual(replacement, { requested: "<1,-1>", source: "<1,4>", result: "<1,2>", removed: 4, inserted: 2 });
                assert.match(String(replacementContext), /^1<@[0-9A-Za-z]{5}>reviewer\n2<@[0-9A-Za-z]{5}>replacement$/, "{§edit-result-receipt-projection} the landed context is anchored");
                assert.equal(edits[1]?.rx.receipt?.replacement, undefined);
                assert.equal(edits[1]?.rx.receipt, undefined, "a rejected operation has no landed effect receipt");
                assert.equal(edits[0]?.rx.editReceipt, undefined);
                assert.equal(edits[1]?.rx.editReceipt, undefined);
            } finally {
                ws.close();
            }
        });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
});

describe("File.scheme.proposal", () => {
// File scheme as the canonical proposal consumer (SPEC.md {§engine-rails} + {§methods}
// + {§membership} D3 — disk co-location). EDIT against a file returns status=202 with a udiff body
// and {path, canonical, patch, patched} attrs; on accept the engine calls
// File.applyResolution which writes patched content to disk.























const fileEditStmt = (pathname: string, body: string, marker: LineMarker | null = null): EditStatement => ({
    metadata: null,
    op: "EDIT", aside: null,
    target: { kind: "local", raw: pathname },
    lineMarker: marker, body, matcher: null, position: { line: 1, column: 1 },
});

const fileReadStmt = (pathname: string): ReadStatement => ({
    metadata: null,
    op: "READ", aside: null,
    target: { kind: "local", raw: pathname },
    lineMarker: null, matcher: null, body: null, position: { line: 1, column: 1 },
});

// Bare-path edit — the form the sysprompt actually trains the model to
// emit. plurnk.md: "Bare paths (no scheme) default to local relative
// project file paths." Engine.#schemeNameOf routes LocalPath → 'file'.
const bareEditStmt = (relPath: string, body: string, marker: LineMarker | null = null): EditStatement => ({
    metadata: null,
    op: "EDIT", aside: null,
    target: { kind: "local", raw: relPath },
    lineMarker: marker, body, matcher: null, position: { line: 1, column: 1 },
});

const deferred = <T>(): { promise: Promise<T>; resolve: (v: T) => void } => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((res) => { resolve = res; });
    return { promise, resolve };
};

// Set up a temp workspace + a workspace whose project_root points at it.
// Returns the temp root for body assertions + a cleanup fn.
const withWorkspaceRoot = async <T>(fn: (root: string, ctx: { db: Db; engine: Engine; workspaceId: number; sessionId: number; loopId: number; turnId: number }) => Promise<T>): Promise<T> => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-file-test-"));
    const db = await openMigrated();
    try {
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const workspaceId = await insertWorkspace(db, `file-${crypto.randomUUID()}`);
        await db.test_set_workspace_project_root.run({ id: workspaceId, project_root: root });
        const sessionId = await insertSession(db, workspaceId);
        await ownSession(db, workspaceId, sessionId);
        const loopId = await insertLoop(db, sessionId, 1, "file edit test");
        const turnId = await insertTurn(db, loopId, 1, 102);
        return await fn(root, { db, engine, workspaceId, sessionId, loopId, turnId });
    } finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
};

test("{§configuration-repair-path}: invalid file creation policy refuses the EDIT without creating a file or proposal", async (t) => {
    const key = "PLURNK_SERVICE_FILE_CREATE_SCOPE";
    const before = process.env[key];
    process.env[key] = "invalid";
    t.after(() => { if (before === undefined) delete process.env[key]; else process.env[key] = before; });
    await withWorkspaceRoot(async (root, ctx) => {
        const result = await ctx.engine.dispatch({ ...ctx, statement: bareEditStmt("new.txt", "must not appear"), sequence: 1, origin: "model" });
        assert.equal(result.status, 503);
        assert.equal(result.problem?.key, key);
        assert.deepEqual(await ctx.engine.pendingProposals(ctx.workspaceId), []);
        await assert.rejects(stat(join(root, "new.txt")), { code: "ENOENT" });
    });
});

for (const decision of ["accept", "reject", "drift"] as const) test(`{§zero-width-column-one-insert}: exact attribute EDIT through a ${decision} file proposal`, async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        const original = '<root><item id = "old" class="kept"/></root>';
        const seed = deferred<number>();
        const creating = ctx.engine.dispatch({ ...ctx, statement: fileEditStmt("source.xml", original), sequence: 1, origin: "model", onDispatch: seed.resolve });
        ctx.engine.resolveProposal(await seed.promise, { decision: "accept" });
        assert.equal((await creating).status, 200);
        const pending = deferred<number>();
        const editing = ctx.engine.dispatch({ ...ctx, sequence: 2, origin: "model", onDispatch: pending.resolve,
            statement: { ...fileEditStmt("source.xml", 'id="new"'), matcher: { dialect: "xpath" as const, raw: "//item/@id" } } });
        const id = await pending.promise;
        if (decision === "drift") await writeFile(join(root, "source.xml"), original.replace("old", "external"));
        ctx.engine.resolveProposal(id, decision === "reject" ? { decision: "reject", outcome: "declined" } : { decision: "accept" });
        const result = await editing;
        assert.equal(result.status, decision === "accept" ? 200 : decision === "reject" ? 400 : 409, JSON.stringify(result));
        assert.equal(await readFile(join(root, "source.xml"), "utf8"), decision === "accept"
            ? '<root><item id="new" class="kept"/></root>' : decision === "drift" ? original.replace("old", "external") : original);
        if (decision !== "accept") assert.match(String(result.problem?.type), decision === "reject" ? /\/rejected$/ : /\/edit-collision$/);
    });
});

test("{§binary-parity}: a deferred byte MOVE cannot remove a source that changed during destination review", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        const source = { authority: "", pathname: "/source.png" };
        const schemeCtx = makeSchemeCtx(ctx);
        const original = new Uint8Array([0, 1, 2, 3, 4]);
        const updated = new Uint8Array([0, 9, 9, 3, 4]);
        assert.equal((await EntryCrud.writeEntry(source, { channels: { body: { content: "", bytes: original, mimetype: "image/png" } } }, schemeCtx, "workspace")).status, 201);
        const pending = deferred<number>();
        const moving = ctx.engine.dispatch({ ...ctx, sequence: 1, origin: "model", onDispatch: pending.resolve,
            statement: moveStmt(urlPath("workspace", "/source.png"), localPath("destination.png"), { marks: [2, 3] }) });
        const id = await pending.promise;
        assert.equal((await EntryCrud.writeEntry(source, { channels: { body: { content: "", bytes: updated, mimetype: "image/png" } } }, schemeCtx, "workspace")).status, 200);
        ctx.engine.resolveProposal(id, { decision: "accept" });
        const result = await moving;
        assert.equal(result.status, 409, JSON.stringify(result));
        assert.match(String(result.problem?.type), /\/edit-collision$/);
        assert.deepEqual(await readFile(join(root, "destination.png")), Buffer.from([1, 2]));
        const read = await EntryCrud.readEntry(source, schemeCtx, "workspace");
        assert.equal(read.entry?.channels.body?.content, Buffer.from(updated).toString("base64"));
    });
});

for (const transfer of [copyStmt, moveStmt]) {
    const op = transfer(urlPath("workspace", "/source"), localPath("destination")).op;
    for (const target of ["destination.bin", "destination", "destination.unknownext"]) {
        for (const shape of ["whole", "scoped", "empty"] as const) {
            test(`{§copy}: ${op} publishes ${shape} bytes at ${target} with the admitted type`, async () => {
                await withWorkspaceRoot(async (root, ctx) => {
                    const source = { authority: "", pathname: "/source" };
                    const schemeCtx = makeSchemeCtx(ctx);
                    const bytes = shape === "empty" ? Buffer.alloc(0) : Buffer.from([0, 0xff, 0x80, 42]);
                    assert.equal((await EntryCrud.writeEntry(source, {
                        channels: { body: { content: "", bytes, mimetype: "application/octet-stream" } },
                    }, schemeCtx, "workspace")).status, 201);
                    const pending = Promise.withResolvers<number>();
                    const applying = ctx.engine.dispatch({ ...ctx, sequence: 1, origin: "model", onDispatch: pending.resolve,
                        statement: transfer(urlPath("workspace", "/source"), localPath(target),
                            shape === "scoped" ? { marks: [2, 3] } : null,
                            shape === "scoped" ? { marks: [0] } : null) });
                    const id = await pending.promise;
                    const proposal = await ctx.db.test_get_log_entry_by_id.get<{ state: string; attrs: string }>({ id });
                    assert.equal(proposal?.state, "proposed", JSON.stringify(proposal));
                    assert.equal(JSON.parse(proposal.attrs).mimetype, "application/octet-stream");
                    await assert.rejects(readFile(join(root, target)), { code: "ENOENT" });
                    await ctx.engine.resolveProposal(id, { decision: "accept" });
                    const result = await applying;
                    assert.equal(result.status, 200, JSON.stringify(result));
                    assert.deepEqual(await readFile(join(root, target)), shape === "scoped" ? bytes.subarray(1, 3) : bytes);
                    const destination = await EntryCrud.readEntry({ authority: "", pathname: target }, schemeCtx, "file");
                    assert.equal(destination.entry?.channels.body?.mimetype, "application/octet-stream");
                    const remaining = await EntryCrud.readEntry(source, schemeCtx, "workspace");
                    if (op === "MOVE" && shape !== "scoped") assert.equal(remaining.status, 404);
                    else assert.equal(remaining.entry?.channels.body?.content,
                        (op === "MOVE" ? Buffer.from([0, 42]) : bytes).toString("base64"));
                });
            });
        }
    }
    test(`{§copy}: rejecting ${op} to an untyped file preserves its byte source`, async () => {
        await withWorkspaceRoot(async (root, ctx) => {
            const source = { authority: "", pathname: "/source" };
            const schemeCtx = makeSchemeCtx(ctx);
            const bytes = Buffer.from([0, 0xff, 42]);
            await EntryCrud.writeEntry(source, { channels: { body: { content: "", bytes, mimetype: "application/octet-stream" } } }, schemeCtx, "workspace");
            const pending = Promise.withResolvers<number>();
            const applying = ctx.engine.dispatch({ ...ctx, sequence: 1, origin: "model", onDispatch: pending.resolve,
                statement: transfer(urlPath("workspace", "/source"), localPath("destination.bin")) });
            const id = await pending.promise;
            const proposals = await ctx.engine.pendingProposals(ctx.workspaceId);
            assert.equal(proposals.length, 1);
            await ctx.engine.resolveProposal(id, { decision: "reject" });
            const result = await applying;
            assert.equal(result.status, 400);
            assert.match(String(result.problem?.type), /\/rejected$/);
            await assert.rejects(readFile(join(root, "destination.bin")), { code: "ENOENT" });
            assert.equal((await EntryCrud.readEntry(source, schemeCtx, "workspace")).entry?.channels.body?.content, bytes.toString("base64"));
        });
    });
}

for (const decision of ["accept", "reject", "replace", "drift"] as const) test(`{§op-methods-op-dispatch}: file proposals with ${decision} preserve the individual mutation boundary`, async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        const original = "one\ntwo\nthree\nfour\nfive\n";
        const target = "sequence.md";
        const seed = deferred<number>();
        const creating = ctx.engine.dispatch({ ...ctx, statement: fileEditStmt(target, original), sequence: 1, origin: "model", onDispatch: seed.resolve });
        ctx.engine.resolveProposal(await seed.promise, { decision: "accept" });
        assert.equal((await creating).status, 200);
        const read = await clientRead(ctx.engine, ctx.db, { ...ctx, statement: { ...fileReadStmt(target), lineMarker: fullReplace } });
        assert.equal(read.status, 200);
        const anchors = read.lineAnchors as string[];
        assert.ok(anchors.length >= 3);
        const source = `\`\`\`\`EDIT (${target}) <2>
TWO
\`\`\`\`
\`\`\`\`EDIT (${target}) <${anchors[2]}>
THREE
\`\`\`\`
\`\`\`\`NOTE
Continue the task.
\`\`\`\``;
        const first = deferred<number>();
        const second = deferred<number>();
        let firstId = 0;
        let dispatched = 0;
        const turn = await Turn.open(ctx.db, { loopId: ctx.loopId, producer: "client", kind: "operation" });
        const execution = ctx.engine.executeAdmittedTurn({
            ...ctx, turnId: turn.id, origin: "client", source, emission: null,
            fromSequence: 1, statements: TurnOps.parseInternal(source),
            onDispatch: (id) => {
                dispatched++;
                if (dispatched === 1) { firstId = id; first.resolve(id); }
                if (dispatched === 2) second.resolve(id);
            },
            onSettled: async (id) => {
                if (id === firstId && decision === "drift") await writeFile(join(root, target), original.replace("two", "TWO").replace("four", "external"));
            },
        });
        ctx.engine.resolveProposal(await first.promise, decision === "reject"
            ? { decision: "reject", outcome: "declined" }
            : { decision: "accept", ...(decision === "replace" ? { body: "reviewer replacement\n" } : {}) });
        const secondId = await second.promise;
        if (decision !== "replace") ctx.engine.resolveProposal(secondId, { decision: "accept" });
        const result = await execution;
        const edits = result.outcomes.filter(({ op }) => op === "EDIT");
        assert.deepEqual(edits.map(({ status }) => status), [decision === "reject" ? 400 : 200, decision === "replace" || decision === "drift" ? 409 : 200]);
        const expected = decision === "replace" ? "reviewer replacement\n"
            : decision === "drift" ? original.replace("two", "TWO").replace("four", "external")
                : (decision === "reject" ? original : original.replace("two", "TWO")).replace("three", "THREE");
        assert.equal(await readFile(join(root, target), "utf8"), expected);
    });
});

test("{§fs-write-surface} file.edit: writes file on accept via applyResolution", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        // Pre-seed an existing file so the EDIT computes a real diff.
        const target = "src/hello.txt";
        // File.edit gates on membership (SPEC {§membership}): a pre-existing file must be a
        // member (git-tracked or client-added) to be editable — register it, the same
        // way READ's gate is satisfied below. A NEW path needs no prior member.
        await mkdir(join(root, "src"), { recursive: true });
        await writeFile(join(root, target), "hello\n", "utf8");
        await ctx.db.test_seed_entry_workspace.get({ attributes: "{}", default_channel: "body", output: 0, workspace_id: ctx.workspaceId, scheme: "file", authority: "", pathname: target });
        await MembershipMaterialization.materializeMember(target, root, makeSchemeCtx({ ...ctx, mimetypes: DEFAULT_MIMETYPES }), new Map());

        // {§edit} — the file exists, so the deliberate
        // full-rewrite escape hatch (<1,-1>) is required; this also proves it works.
        const stmt = fileEditStmt(target, "hello world\n", fullReplace);
        const idDeferred = deferred<number>();
        const dispatchPromise = ctx.engine.dispatch({
            statement: stmt, workspaceId: ctx.workspaceId, sessionId: ctx.sessionId,
            loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        const logEntryId = await idDeferred.promise;
        const row = await ctx.db.test_get_log_entry_by_id.get<{ state: string; status_rx: number; attrs: string }>({ id: logEntryId });
        assert.equal(row?.state, "proposed");
        assert.equal(row?.status_rx, 202);
        const attrs = JSON.parse(row?.attrs ?? "{}") as { path: string; canonical: string; patch: string; patched: string };
        assert.equal(attrs.path, target); // bare canon ({§fs-namespace})
        assert.equal(attrs.patched, "hello world\n");
        assert.match(attrs.patch, /^Index: src\/hello\.txt/);
        assert.match(attrs.patch, /-hello/);
        assert.match(attrs.patch, /\+hello world/);

        ctx.engine.resolveProposal(logEntryId, { decision: "accept" });
        const result = await dispatchPromise;
        assert.equal(result.status, 200);
        const onDisk = await readFile(join(root, target), "utf8");
        assert.equal(onDisk, "hello world\n");
        // The applied EDIT's rx carries the bounded structured receipt computed from what landed.
        const applied = await ctx.db.test_get_log_entry_by_id.get<{ status_rx: number; rx: string }>({ id: logEntryId });
        assert.equal(applied?.status_rx, 200);
        const appliedRx = JSON.parse(applied?.rx ?? "{}") as {
            receipt?: { revision?: string; effect?: { context?: string } };
        };
        assert.match(appliedRx.receipt?.revision ?? "", /^[a-f0-9]{64}$/);
        assert.match(appliedRx.receipt?.effect?.context ?? "", /1(?:<@[0-9A-Za-z]{5}>|:)hello world/, "applied EDIT rx shows bounded landed context");
    });
});

test("{§engine-rails} file.edit: a landed source receipt reports parser recovery against its preserved mimetype", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        const target = "broken.go";
        const id = deferred<number>();
        const dispatched = ctx.engine.dispatch({
            statement: fileEditStmt(target, "package sample\nfunc broken("),
            workspaceId: ctx.workspaceId,
            sessionId: ctx.sessionId,
            loopId: ctx.loopId,
            turnId: ctx.turnId,
            sequence: 1,
            origin: "model",
            onDispatch: (logEntryId) => id.resolve(logEntryId),
        });
        const logEntryId = await id.promise;
        ctx.engine.resolveProposal(logEntryId, { decision: "accept" });
        const result = await dispatched;
        assert.equal(result.status, 200);

        const row = await ctx.db.test_get_log_entry_by_id.get<{ rx: string }>({ id: logEntryId });
        const rx = JSON.parse(row?.rx ?? "{}") as {
            receipt?: { parseIssues?: { before: number; after: number } };
        };
        assert.equal(rx.receipt?.parseIssues?.before, 0, JSON.stringify(rx));
        assert.ok(Number.isSafeInteger(rx.receipt?.parseIssues?.after));
        assert.ok((rx.receipt?.parseIssues?.after ?? 0) > 0, JSON.stringify(rx));
        const channel = await ctx.db.test_get_channel_by_pathname_scheme.get<{ mimetype: string }>({
            pathname: target,
            scheme: "file",
            name: "body",
        });
        assert.equal(channel?.mimetype, "text/x-go");
        assert.equal(await readFile(join(root, target), "utf8"), "package sample\nfunc broken(");
    });
});

test("{§engine-rails} file.applyResolution: malformed accepted proposal state remains an internal invariant", async () => {
    await withWorkspaceRoot(async (_root, ctx) => {
        await assert.rejects(
            new File().applyResolution(
                { attrs: {}, metadata: null },
                makeSchemeCtx({
                    db: ctx.db,
                    workspaceId: ctx.workspaceId,
                    sessionId: ctx.sessionId,
                    loopId: ctx.loopId,
                    turnId: ctx.turnId,
                }),
            ),
            InvalidOperationResultError,
        );
    });
});

test("{§engine-rails} file.edit: an unchanged file is a 304 no-op and never becomes a proposal", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        const target = "unchanged.txt";
        const original = "same\n";
        await writeFile(join(root, target), original, "utf8");
        await ctx.db.test_seed_entry_workspace.get({ attributes: "{}", default_channel: "body", output: 0,
            workspace_id: ctx.workspaceId,
            scheme: "file",
            authority: "",
            pathname: target,
        });
        await MembershipMaterialization.materializeMember(target, root, makeSchemeCtx({ ...ctx, mimetypes: DEFAULT_MIMETYPES }), new Map());

        const idDeferred = deferred<number>();
        const result = await ctx.engine.dispatch({
            statement: fileEditStmt(target, original, fullReplace),
            workspaceId: ctx.workspaceId,
            sessionId: ctx.sessionId,
            loopId: ctx.loopId,
            turnId: ctx.turnId,
            sequence: 1,
            origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        assert.equal(result.status, 304);
        assert.equal(
            result.detail,
            "No change: EDIT body matches the selected content.",
        );
        assert.equal(await readFile(join(root, target), "utf8"), original);

        const row = await ctx.db.test_get_log_entry_by_id.get<{ state: string; status_rx: number }>({
            id: await idDeferred.promise,
        });
        assert.equal(row?.state, "resolved");
        assert.equal(row?.status_rx, 304);
    });
});

test("{§proposal} file.edit: rejection leaves file untouched; the rx carries a durable Problem Details result", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        const target = "untouched.txt";
        // pre-existing file must be a member to be editable (SPEC {§membership} edit gate)
        await ctx.db.test_seed_entry_workspace.get({ attributes: "{}", default_channel: "body", output: 0, workspace_id: ctx.workspaceId, scheme: "file", authority: "", pathname: target });
        await writeFile(join(root, target), "original\n", "utf8");
        await MembershipMaterialization.materializeMember(target, root, makeSchemeCtx({ ...ctx, mimetypes: DEFAULT_MIMETYPES }), new Map());

        const stmt = fileEditStmt(target, "should-not-land\n", fullReplace);
        const idDeferred = deferred<number>();
        const dispatchPromise = ctx.engine.dispatch({
            statement: stmt, workspaceId: ctx.workspaceId, sessionId: ctx.sessionId,
            loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        const logEntryId = await idDeferred.promise;
        ctx.engine.resolveProposal(logEntryId, { decision: "reject", outcome: "reviewer_said_no" });
        const result = await dispatchPromise;
        assert.equal(result.status, 400);
        const onDisk = await readFile(join(root, target), "utf8");
        assert.equal(onDisk, "original\n", "rejected EDIT must not touch disk");
        // The model-facing rx carries the one-word why — a mute {"status":400} reads as a
        // phantom failure the model can't act on (the fan-out dead-park).
        const row = await ctx.db.test_get_log_entry_by_id.get<{ rx: string }>({ id: logEntryId });
        const rx = JSON.parse(row?.rx ?? "{}") as {
            status?: number;
            outcome?: string;
            problem?: { type?: string; status?: number; detail?: string; instance?: string; stage?: string; retryable?: boolean };
        };
        assert.equal(rx.status, 400);
        assert.equal(rx.outcome, "reviewer_said_no");
        assert.deepEqual(rx.problem, {
            type: "https://problems.plurnk.xyz/proposal/rejected",
            title: "Rejected",
            status: 400,
            detail: "The proposal was rejected (reviewer_said_no).",
            instance: "log:///1/1/1/EDIT",
            stage: "proposal-settlement",
            retryable: false,
        });
    });
});

test("{§engine-rails} file.edit: creates a new file on accept (target doesn't exist)", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        await mkdir(join(root, "new-dir"), { recursive: true });
        const target = "new-dir/new-file.md";
        const stmt = fileEditStmt(target, "# Created via proposal\n");

        const idDeferred = deferred<number>();
        const dispatchPromise = ctx.engine.dispatch({
            statement: stmt, workspaceId: ctx.workspaceId, sessionId: ctx.sessionId,
            loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        const logEntryId = await idDeferred.promise;
        ctx.engine.resolveProposal(logEntryId, { decision: "accept" });
        const result = await dispatchPromise;
        assert.equal(result.status, 200);
        const onDisk = await readFile(join(root, target), "utf8");
        assert.equal(onDisk, "# Created via proposal\n");
    });
});

test("{§edit-result-receipt-projection}: reviewer-modified acceptance receipts the landed content", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        const target = "reviewed.md";
        const stmt = fileEditStmt(target, "model proposal\n");
        const idDeferred = deferred<number>();
        const dispatchPromise = ctx.engine.dispatch({
            statement: stmt, workspaceId: ctx.workspaceId, sessionId: ctx.sessionId,
            loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        const logEntryId = await idDeferred.promise;
        const reviewed = "reviewer revision\n";
        ctx.engine.resolveProposal(logEntryId, { decision: "accept", body: reviewed });
        await dispatchPromise;
        assert.equal(await readFile(join(root, target), "utf8"), reviewed);
        const row = await ctx.db.test_get_log_entry_by_id.get<{ rx: string }>({ id: logEntryId });
        const rx = JSON.parse(row?.rx ?? "{}") as {
            receipt?: {
                revision?: string;
                disposition?: string;
                requested?: string;
                replacement?: { context?: string };
            };
        };
        assert.equal(rx.receipt?.revision, createHash("sha256").update(reviewed).digest("hex"));
        assert.equal(rx.receipt?.disposition, "superseded");
        assert.equal(rx.receipt?.requested, "<1,-1>");
        assert.match(rx.receipt?.replacement?.context ?? "", /1(?:<@[0-9A-Za-z]{5}>|:)reviewer revision/);
        assert.doesNotMatch(rx.receipt?.replacement?.context ?? "", /model proposal/);
    });
});

test("{§membership}: accepted file creation creates missing parent directories", async () => {
    // The write-back edge creates the target's missing parent directories.
    await withWorkspaceRoot(async (root, ctx) => {
        const target = "tasks/nested/extract_config_values.md";
        const stmt = fileEditStmt(target, "# task\n");
        const idDeferred = deferred<number>();
        const dispatchPromise = ctx.engine.dispatch({
            statement: stmt, workspaceId: ctx.workspaceId, sessionId: ctx.sessionId,
            loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        const logEntryId = await idDeferred.promise;
        ctx.engine.resolveProposal(logEntryId, { decision: "accept" });
        const result = await dispatchPromise;
        assert.equal(result.status, 200, "the accept applies — never write_failed on a missing parent");
        const onDisk = await readFile(join(root, target), "utf8");
        assert.equal(onDisk, "# task\n");
    });
});

test("{§op-shapes} {§edit}: markerless EDIT refuses an existing file", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        const target = "src/Engine.ts";
        await mkdir(join(root, "src"), { recursive: true });
        const original = "line one\nline two\nline three\n";
        await writeFile(join(root, target), original, "utf8");
        await ctx.db.test_seed_entry_workspace.get({ attributes: "{}", default_channel: "body", output: 0, workspace_id: ctx.workspaceId, scheme: "file", authority: "", pathname: target });
        await MembershipMaterialization.materializeMember(target, root, makeSchemeCtx({ ...ctx, mimetypes: DEFAULT_MIMETYPES }), new Map());

        // A marker meant for the target landed inside the body text
        // instead (a model syntax slip), so the dispatched statement carries no marker at all.
        const stmt = fileEditStmt(target, "<2>:// AUDIT-OK\nline two");
        const result = await ctx.engine.dispatch({
            statement: stmt, workspaceId: ctx.workspaceId, sessionId: ctx.sessionId,
            loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
        });
        assert.equal(result.status, 400, "no marker on an existing file is refused outright — never a proposal, never a silent replace");
        assert.equal(result.problem?.type, "https://problems.plurnk.xyz/scheme/file/line-marker-required");
        assert.match(result.problem?.detail ?? "", /requires a line marker/);
        assert.match(result.problem?.recovery ?? "", /<1,-1>/, "the recovery names the explicit whole-file form");
        const onDisk = await readFile(join(root, target), "utf8");
        assert.equal(onDisk, original, "disk is untouched — the refusal happens before any proposal, let alone any write");
    });
});

test("{§engine-rails} file.edit: refuses traversal escape", async () => {
    await withWorkspaceRoot(async (_root, ctx) => {
        const stmt = fileEditStmt("../escape.txt", "nope\n");
        const result = await ctx.engine.dispatch({
            statement: stmt, workspaceId: ctx.workspaceId, sessionId: ctx.sessionId,
            loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
        });
        assert.equal(result.status, 403);
    });
});

test("{§membership} bare target: EDIT(relative/path) routes to file scheme (no scheme prefix)", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        const target = "from-bare.txt";
        // pre-existing file must be a member to be editable (SPEC {§membership} edit gate);
        // materialize the body channel too — the marker math below reads `original`.
        await writeFile(join(root, target), "original\n", "utf8");
        await ctx.db.test_seed_entry_workspace.get({ attributes: "{}", default_channel: "body", output: 0, workspace_id: ctx.workspaceId, scheme: "file", authority: "", pathname: target });
        await MembershipMaterialization.materializeMember(target, root, makeSchemeCtx({ ...ctx, mimetypes: DEFAULT_MIMETYPES }), new Map());

        // No file:/// prefix — the form the sysprompt teaches. The file exists, so the
        // marker is required ({§edit}).
        const stmt = bareEditStmt(target, "bare-path edit\n", fullReplace);
        const idDeferred = deferred<number>();
        const dispatchPromise = ctx.engine.dispatch({
            statement: stmt, workspaceId: ctx.workspaceId, sessionId: ctx.sessionId,
            loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
            onDispatch: (id) => idDeferred.resolve(id),
        });
        const logEntryId = await idDeferred.promise;

        const row = await ctx.db.test_get_log_entry_by_id.get<{ state: string; status_rx: number; attrs: string }>({ id: logEntryId });
        assert.equal(row?.status_rx, 202, "bare path EDIT must route to file scheme + propose");
        assert.equal(row?.state, "proposed");
        const attrs = JSON.parse(row?.attrs ?? "{}") as { path: string };
        assert.equal(attrs.path, target); // bare canon ({§fs-namespace})

        ctx.engine.resolveProposal(logEntryId, { decision: "accept" });
        const result = await dispatchPromise;
        assert.equal(result.status, 200);
        const onDisk = await readFile(join(root, target), "utf8");
        assert.equal(onDisk, "bare-path edit\n");
    });
});

test("{§engine-rails} file.read: reads the materialized entry beside the edit path", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        const target = "read-me.txt";
        await writeFile(join(root, target), "content\n", "utf8");
        // File.read serves the materialized entry — materialize the content
        // (production's git-membership pass does this), not just a membership marker.
        const writeCtx: PlurnkSchemeContext = {
            db: ctx.db, workspaceId: ctx.workspaceId, sessionId: ctx.sessionId, loopId: ctx.loopId, turnId: ctx.turnId,
            writer: "model", signal: undefined, weigh: (t: string) => t.length,
        };
        await EntryCrud.writeEntry({ authority: "", pathname: target }, { channels: { body: { content: "content\n", mimetype: "text/markdown" } } }, writeCtx, "file");

        const stmt = fileReadStmt(target);
        const result = await ctx.engine.dispatch({
            statement: stmt, workspaceId: ctx.workspaceId, sessionId: ctx.sessionId,
            loopId: ctx.loopId, turnId: ctx.turnId, sequence: 1, origin: "model",
        });
        assert.equal(result.status, 200);
    });
});

test("{§engine-rails} file.edit: headless workspace (no project_root) → 400", async () => {
    // A workspace with no project_root returns 400 with a clear error naming
    // the contract: file ops need a workspace created with projectRoot
    // (headless is forever).
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `headless-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "headless");
        const turnId = await insertTurn(db, loopId, 1, 102);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const stmt = bareEditStmt("any.txt", "content\n");
        const result = await engine.dispatch({
            statement: stmt, workspaceId, sessionId, loopId, turnId,
            sequence: 1, origin: "model",
        });
        assert.equal(result.status, 400);
    } finally { await db.close(); }
});
});

describe("auto-anti-clobber", () => {
// Hash-anchored stale-read anti-clobber. The model READs V1, the file changes to V2
// outside Plurnk, and its V1 anchor must reject the later EDIT before proposal.













const execFileP = promisify(execFile);

test("{§edit} a stale hash anchor rejects an EDIT before proposal — no silent clobber", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const root = await mkdtemp(join(tmpdir(), "plurnk-clobber-"));
    try {
        await execFileP("git", ["init", "-q"], { cwd: root, env: hermeticGitEnv() });
        await execFileP("git", ["config", "user.email", "fixture@plurnk.invalid"], { cwd: root, env: hermeticGitEnv() });
        await execFileP("git", ["config", "user.name", "t"], { cwd: root, env: hermeticGitEnv() });
        await writeFile(join(root, "doc.md"), "V1 original\n");
        await execFileP("git", ["add", "doc.md"], { cwd: root, env: hermeticGitEnv() });
        await execFileP("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--no-verify", "-q", "-m", "seed"], { cwd: root, env: hermeticGitEnv() });

        const staleAnchor = LineAnchors.token("doc.md", 1, "V1 original\n");
        const mock = new Mock({ contextWindow: 32768, responses: [
            makeMockResponse("````READ (doc.md)````\n````NOTE\nReview the file.\n````", 50),
            makeMockResponse("````SEND [200]\nRead complete.\n````", 50),
            makeMockResponse(`\`\`\`\`EDIT (doc.md) <${staleAnchor}>
V3 model clobber
\`\`\`\`

\`\`\`\`SEND
done
\`\`\`\`
\`\`\`\`SEND
\`\`\`\``, 50),
            makeMockResponse("````SEND [200]\nStale edit rejected.\n````", 50),
        ] });
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "clobber", projectRoot: root });
                // Loop 1 publishes the exact V1 anchor into the model's log.
                const first = await runLoopToTerminal(ws, 2, { prompt: "look" });
                assert.equal(first.result.status, 200, "the V1 READ completed before the anti-clobber exercise");

                // The file changes out-of-band between turns.
                await writeFile(join(root, "doc.md"), "V2 ambient change\n");

                // Loop 2 reconciles V2 before the model attempts its V1-anchored edit.
                const second = await runLoopToTerminal(ws, 3, { prompt: "edit it" });
                assert.equal(second.result.status, 200, "the stale EDIT was exercised and the model concluded normally");
                assert.equal(second.modelSessionId, first.modelSessionId, "both loops use the same session memory");
                const rows = await db.engine_render_log.all<{ op: string; status_rx: number; rx: string }>({
                    session_id: second.modelSessionId!,
                });
                const rejected = rows.find(({ op, status_rx }) => op === "EDIT" && status_rx === 409);
                assert.equal(
                    JSON.parse(rejected?.rx ?? "null")?.problem?.type,
                    "https://problems.plurnk.xyz/engine/edit/edit-collision",
                    "the stale anchor produces the exact edit-collision result before any proposal",
                );

                const onDisk = await readFile(join(root, "doc.md"), "utf8");
                assert.match(onDisk, /V2 ambient change/, "the ambient on-disk change survives — the stale auto EDIT was rejected, never written");
                assert.doesNotMatch(onDisk, /V3 model clobber/, "the model's stale V3 EDIT did NOT reach disk (no silent clobber)");
            } finally { ws.close(); }
        });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
});

describe("edit-pattern", () => {
// {§edit-pattern} — a pattern on an EDIT replaces each matching span, within its line, with the
// literal body; every touched line's anchor guards the batch. Zero matches change nothing.










const setup = async (content = "alpha foo\nfoo bar foo\nbeta\nfoo", pathname = "/notes.md") => {
    const db = await openMigrated();
    const env = await seedEnvelope(db, `ws-${crypto.randomUUID()}`, { producer: "client" });
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
    await new Workspace().edit(editStmt(urlPath("workspace", pathname), content), makeSchemeCtx({ db, workspaceId: env.workspaceId, sessionId: env.sessionId }));
    let sequence = 0;
    const dispatch = (statement: EditStatement) => {
        sequence += 1;
        return engine.dispatch({ statement, workspaceId: env.workspaceId, sessionId: env.sessionId, loopId: env.loopId, turnId: env.turnId, sequence, origin: "client" });
    };
    const body = async () => (await db.test_get_channel_by_pathname.get<{ content: string }>({ pathname, name: "body" }))?.content;
    return { db, dispatch, body };
};

const target = urlPath("workspace", "/notes.md");
const regex = (pattern: string, flags = ""): MatcherBody => ({ dialect: "regex", raw: `/${pattern}/${flags}`, pattern, flags });

test("{§edit-pattern} selection runs on canonical source, including its original line separators", async () => {
    const { db, dispatch, body } = await setup("before\r\nneedle\r\nafter");
    try {
        const result = await dispatch(editStmt(target, " / ", null, regex("\\r\\n")));
        assert.equal(result.status, 200, JSON.stringify(result));
        assert.equal(result.matched, 2);
        assert.equal(await body(), "before / needle / after");
    } finally { await db.close(); }
});

test("{§zero-width-column-one-insert} authored insertion uses the source's separator, not its READ presentation", async () => {
    const { db, dispatch, body } = await setup("before\r\nafter");
    try {
        const result = await dispatch(editStmt(target, "inserted", { marks: [2, 1, 2, 1] }));
        assert.equal(result.status, 200, JSON.stringify(result));
        assert.equal(await body(), "before\r\ninserted\r\nafter");
    } finally { await db.close(); }
});

test("{§edit-pattern} pattern replacement preserves the body's literal line endings", async () => {
    const { db, dispatch, body } = await setup("before\r\nneedle\r\nafter");
    try {
        const result = await dispatch(editStmt(target, "first\r\nsecond\rthird", null, regex("needle")));
        assert.equal(result.status, 200, JSON.stringify(result));
        assert.equal(await body(), "before\r\nfirst\r\nsecond\rthird\r\nafter");
    } finally { await db.close(); }
});

test("{§edit-pattern} a literal pattern replaces every occurrence on every line with the literal body", async () => {
    const { db, dispatch, body } = await setup();
    try {
        const r = await dispatch(editStmt(target, "baz", null, { dialect: "glob", raw: "foo" }));
        assert.equal(r.status, 200, JSON.stringify(r));
        assert.equal(r.matched, 4, "every occurrence counts, two on one line included");
        assert.equal(await body(), "alpha baz\nbaz bar baz\nbeta\nbaz");
        const receipt = r.receipt as { effect: { requested: string } };
        assert.equal(receipt.effect.requested, "<1,7,1,10>", "the receipt is the first span's coordinate edit");
        assert.equal((r.last as { requested: string }).requested, "<4,1,4,4>", "and the last span rides beside it");
    } finally { await db.close(); }
});

test("{§edit-pattern} a regex pattern replaces its spans; the body is literal, never a template", async () => {
    const { db, dispatch, body } = await setup("id: 12\nid: 345\nname: x");
    try {
        const r = await dispatch(editStmt(target, "$1-<0>", null, regex("\\d+")));
        assert.equal(r.status, 200, JSON.stringify(r));
        assert.equal(r.matched, 2);
        assert.equal(await body(), "id: $1-<0>\nid: $1-<0>\nname: x");
    } finally { await db.close(); }
});

test("{§edit-pattern} a scope bounds the lines a pattern may touch; a glob with metacharacters replaces whole lines", async () => {
    const { db, dispatch, body } = await setup("keep\nold value\nold thing\nkeep");
    try {
        const r = await dispatch(editStmt(target, "new", { marks: [2] }, { dialect: "glob", raw: "old*" }));
        assert.equal(r.status, 200, JSON.stringify(r));
        assert.equal(r.matched, 1);
        assert.equal(await body(), "keep\nnew\nold thing\nkeep");
    } finally { await db.close(); }
});

test("{§edit-pattern} zero matches change nothing and answer 204 with matched 0", async () => {
    const { db, dispatch, body } = await setup();
    try {
        const r = await dispatch(editStmt(target, "baz", null, { dialect: "glob", raw: "absent" }));
        assert.equal(r.status, 204, JSON.stringify(r));
        assert.equal(r.matched, 0);
        assert.equal(await body(), "alpha foo\nfoo bar foo\nbeta\nfoo");
    } finally { await db.close(); }
});

test("{§edit-pattern} an empty body deletes the matched spans and leaves the lines", async () => {
    const { db, dispatch, body } = await setup("a foo b\nfoo");
    try {
        const r = await dispatch(editStmt(target, "", null, { dialect: "glob", raw: "foo" }));
        assert.equal(r.status, 200, JSON.stringify(r));
        assert.equal(await body(), "a  b\n", "spans go, lines stay");
    } finally { await db.close(); }
});

test("{§edit-pattern} a regex pattern replaces its exact region across a line break", async () => {
    const { db, dispatch, body } = await setup("one\ntwo");
    try {
        const r = await dispatch(editStmt(target, "x", null, regex("one\\ntwo")));
        assert.equal(r.status, 200, JSON.stringify(r));
        assert.equal(r.matched, 1);
        assert.equal(await body(), "x");
    } finally { await db.close(); }
});

test("{§edit-pattern} a node-selecting pattern replaces each node's whole region, across lines", async () => {
    const xml = "<books>\n  <book>\n    <title>A</title>\n    <price>40</price>\n  </book>\n  <book>\n    <title>B</title>\n    <price>10</price>\n  </book>\n</books>";
    const { db, dispatch, body } = await setup(xml, "/books.xml");
    try {
        const r = await dispatch(editStmt(urlPath("workspace", "/books.xml"), "<book/>", null, { dialect: "xpath", raw: "//book[price > 35]" }));
        assert.equal(r.status, 200, JSON.stringify(r));
        assert.equal(r.matched, 1);
        assert.equal(await body(), "<books>\n  <book/>\n  <book>\n    <title>B</title>\n    <price>10</price>\n  </book>\n</books>", "surrounding indentation is not part of the element");
    } finally { await db.close(); }
});

test("{§edit-pattern} a jsonpath pattern with an empty body removes the selected nodes' text", async () => {
    const { db, dispatch, body } = await setup('{"items": [\n  {"name": "a", "price": 10},\n  {"name": "b", "price": 50}\n]}', "/data.json");
    try {
        const r = await dispatch(editStmt(urlPath("workspace", "/data.json"), "", null, { dialect: "jsonpath", raw: "$.items[?(@.price > 20)]" }));
        assert.equal(r.status, 200, JSON.stringify(r));
        assert.equal(r.matched, 1);
        assert.equal(await body(), '{"items": [\n  {"name": "a", "price": 10},\n  \n]}');
    } finally { await db.close(); }
});

test("{§edit-pattern} a full-text pattern replaces SQLite's located token occurrences", async () => {
    const { db, dispatch, body } = await setup();
    try {
        const r = await dispatch(editStmt(target, "x", null, { dialect: "fts", raw: "~foo" }));
        assert.equal(r.status, 200, JSON.stringify(r));
        assert.equal(r.matched, 4);
        assert.equal(await body(), "alpha x\nx bar x\nbeta\nx");
    } finally { await db.close(); }
});

for (const matcher of [{ dialect: "glob", raw: "foo" }, regex("foo"), { dialect: "fts", raw: "~foo" }] as const) {
    test(`{§edit-pattern} a four-coordinate scope bounds ${matcher.dialect} EDIT without broadening to the line`, async () => {
        const { db, dispatch, body } = await setup("foo foo foo");
        try {
            const r = await dispatch(editStmt(target, "bar", { marks: [1, 5, 1, 8] }, matcher));
            assert.equal(r.status, 200, JSON.stringify(r));
            assert.equal(r.matched, 1);
            assert.equal(await body(), "foo bar foo");
        } finally { await db.close(); }
    });
}

test("{§edit-pattern} a pattern on an existing empty entry is a no-match, not a missing resource", async () => {
    const { db, dispatch, body } = await setup("");
    try {
        const r = await dispatch(editStmt(target, "x", null, regex("foo")));
        assert.equal(r.status, 204, JSON.stringify(r));
        assert.equal(r.matched, 0);
        assert.equal(await body(), "");
    } finally { await db.close(); }
});

// {§edit-pattern} {§channel-selection} — a regex splices the source channel's own coordinates: on
// HTML the markup, never the readable projection beside it.
test("{§edit-pattern} a regex pattern edits HTML source coordinates; the readable projection follows", async () => {
    const { db, dispatch, body } = await setup("<html>\n  <body>\n    <h1>Team Roster</h1>\n  </body>\n</html>", "/users.html");
    try {
        const r = await dispatch(editStmt(urlPath("workspace", "/users.html"), "<h2>Roster</h2>", null, { dialect: "regex", raw: "/<h1>.*<\\/h1>/", pattern: "<h1>.*<\\/h1>", flags: "" }));
        assert.equal(r.status, 200, JSON.stringify(r));
        assert.equal(r.matched, 1);
        assert.equal(await body(), "<html>\n  <body>\n    <h2>Roster</h2>\n  </body>\n</html>");
        const projection = await db.test_get_channel_by_pathname.get<{ content: string }>({ pathname: "/users.html", name: "readable" });
        assert.match(String(projection?.content), /Roster/, "the derived projection followed the source write");
    } finally { await db.close(); }
});

test("{§edit-result-receipt-projection} a multi-span pattern receipt renders as a packet row: both boundaries, every line framed", async () => {
    const { db, dispatch, body } = await setup("alpha\nbeta\ngamma\ndelta");
    try {
        const r = await dispatch(editStmt(target, "A", null, regex("a$", "gm")));
        assert.equal(r.status, 200, JSON.stringify(r));
        assert.equal(r.matched, 4);
        assert.equal(await body(), "alphA\nbetA\ngammA\ndeltA");
        assert.ok("last" in r, "several spans: the receipt carries the last boundary beside the first");
        const entry = { coordinate: "1/1/1", origin: "model", op: "EDIT", status: 200, folded: [], target: { scheme: "workspace", pathname: "/notes.md" }, tx: { body: "A" }, rx: r };
        // The next packet renders this row; a body with an unframed line is a 500 on the whole loop.
        const rendered = PacketWire.renderLog([entry], (s: string) => Math.ceil(s.length / 4));
        assert.match(rendered, /alphA/u);
        assert.match(rendered, /deltA/u);
        assert.doesNotMatch(rendered, /\n\n *[1-9]\d*<@/u, "no blank line inside the receipt body");
    } finally { await db.close(); }
});
});

describe("floor-scope-capstone", () => {
// Floor-scope capstone — drives the non-execution entry DSL ops end-to-end through the
// canonical grammar parser, real Engine, real SchemeRegistry, real SqlRite.











const parse = (dsl: string): PlurnkStatement[] => {
    const result = PlurnkParser.parseStatements(dsl, { executors: fixtureExecutors(dsl) });
    return result.items
        .filter((i) => i.kind === "statement")
        .map((i) => i.statement);
};

test("{§edit} Floor-scope capstone: full DSL surface exercised end-to-end", async () => {
    const db = await openMigrated();
    const env = await seedEnvelope(db, "capstone-ws", { producer: "client" });
    // FIND body matchers run content through the mimetypes framework,
    // so the end-to-end engine needs a real (discovering) Mimetypes — same as the
    // daemon wires in production; the bare default has no handlers.
    await DEFAULT_MIMETYPES.ready();
    const schemes = new SchemeRegistry();
    schemes.register("fixture", new EntryScheme());
    const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });

    const dispatch = async (statement: PlurnkStatement, sequence: number) =>
        engine.dispatch({ statement, ...env, sequence, origin: "client" });

    try {
        const [editQuestion] = parse("````EDIT (workspace:///france/capital)\nwhat is the capital of france?\n````");
        const r1 = await dispatch(editQuestion, 1);
        assert.equal(r1.status, 201);
        const questionEntryId = r1.entryId as number;
        assert.ok(typeof questionEntryId === "number");

        const channels1 = await db.test_list_channel_names.all<{ name: string }>({ entry_id: questionEntryId });
        assert.deepEqual(channels1.map((c) => c.name), ["body"]);

        // {§edit} — the entry already exists (created above), so
        // the re-edit needs a marker; <1,-1> states the deliberate full rewrite.
        const [editQuestionAgain] = parse("````EDIT (workspace:///france/capital) <1,-1>\nrephrased question\n````");
        const r2 = await dispatch(editQuestionAgain, 2);
        assert.equal(r2.status, 200);
        assert.equal(r2.entryId, questionEntryId);
        const body2 = (await db.test_get_channel.get<{ content: string }>({ entry_id: questionEntryId, name: "body" }))?.content;
        assert.equal(body2, "rephrased question");

        const [copyOp] = parse("````COPY (workspace:///france/capital) (fixture:///france/capital)````");
        const r3 = await dispatch(copyOp, 3);
        assert.equal(r3.status, 201);

        const skillEntry = await db.test_get_entry_id_by_scheme_pathname.get<{ id: number }>({ scheme: "fixture", pathname: "/france/capital" });
        const skillEntryId = skillEntry!.id;

        // The COPY above already created this entry, so the edit needs a marker too.
        const [editSkill] = parse("````EDIT (fixture:///france/capital) <1,-1>\nParis\n````");
        const r4 = await dispatch(editSkill, 4);
        assert.equal(r4.status, 200);
        const skillBody = (await db.test_get_channel.get<{ content: string }>({ entry_id: skillEntryId, name: "body" }))?.content;
        assert.equal(skillBody, "Paris");

        const [classifiedFind] = parse("````FIND (fixture:///)````");
        const r6 = await dispatch(classifiedFind, 5);
        assert.equal(r6.status, 200);
        assert.deepEqual((r6.results as Array<[{ path: string }]>).map(([resource]) => resource.path), ["fixture:///france/capital"]);

        // glob body matches CONTENT (the entry's body is "Paris"), not the pathname.
        const [findByGlob] = parse("````FIND (fixture:///) Paris*````");
        const r7 = await dispatch(findByGlob, 6);
        assert.equal(r7.status, 200);
        assert.deepEqual((r7.results as Array<[{ path: string }]>).map(([resource]) => resource.path), ["fixture:///france/capital"]);

        const [moveOp] = parse("````MOVE (workspace:///france/capital) (workspace:///archive/france/capital)````");
        const r10 = await dispatch(moveOp, 9);
        assert.equal(r10.status, 201);
        const oldGone = await db.test_get_entry_id_by_scheme_pathname.get<{ id: number }>({ scheme: "workspace", pathname: "/france/capital" });
        assert.equal(oldGone, undefined);
        const archive = await db.test_get_entry_id_by_scheme_pathname.get<{ id: number }>({ scheme: "workspace", pathname: "/archive/france/capital" });
        const archiveBody = (await db.test_get_channel.get<{ content: string }>({ entry_id: archive?.id, name: "body" }))?.content;
        assert.equal(archiveBody, "rephrased question"); // the commons original — Paris lives on the skill copy

        const [deleteOp] = parse("````KILL (fixture:///france/capital)````");
        const r11 = await dispatch(deleteOp, 10);
        assert.equal(r11.status, 200);
        const skillGone = await db.test_get_entry_id_by_scheme_pathname.get<{ id: number }>({ scheme: "fixture", pathname: "/france/capital" });
        assert.equal(skillGone, undefined);

        const [send] = parse("````SEND\nanswer delivered\n````");
        const r12 = await engine.executeAdmittedTurn({ ...env, statements: [send], source: null, emission: null, fromSequence: 11, origin: "client" });
        assert.equal(r12.status, 200);
        assert.equal((await db.test_get_loop_status.get<{ status: number }>({ id: env.loopId }))?.status, 102, "delivering a message does not complete work");

        const allEntries = (await db.test_list_entries_by_workspace_workspace_pathname.all<{ scheme: string; pathname: string }>({ workspace_id: env.workspaceId })).map((r) => ({ scheme: r.scheme, pathname: r.pathname }));
        assert.deepEqual(allEntries, [{ scheme: "workspace", pathname: "/archive/france/capital" }]);

        const logCount = (await db.test_count_log_entries_by_session.get<{ n: number }>({ session_id: env.sessionId }))?.n;
        assert.equal(logCount, 9);

        const clientLogCount = (await db.test_count_log_entries_session_origin.get<{ n: number }>({ session_id: env.sessionId, origin: "client" }))?.n;
        assert.equal(clientLogCount, 9);
    } finally { await db.close(); }
});
});


describe("pattern-contract", () => {
const TEXT = "spare\none needle end\nspare\nneedle";
const TEXT_LINES = [2, 4];

const cases = [
    { name: "literal", extension: "txt", pattern: "needle", content: TEXT, lines: TEXT_LINES, edited: "spare\none replacement end\nspare\nreplacement", copied: "needleneedle", removed: "spare\none  end\nspare\n" },
    { name: "glob", extension: "txt", pattern: "*needle*", content: TEXT, lines: TEXT_LINES, edited: "spare\nreplacement\nspare\nreplacement", copied: "one needle endneedle", removed: "spare\n\nspare\n" },
    { name: "extglob", extension: "txt", pattern: "@(one needle end|needle)", content: TEXT, lines: TEXT_LINES, edited: "spare\nreplacement\nspare\nreplacement", copied: "one needle endneedle", removed: "spare\n\nspare\n" },
    { name: "brace glob", extension: "txt", pattern: "{one needle end,needle}", content: TEXT, lines: TEXT_LINES, edited: "spare\nreplacement\nspare\nreplacement", copied: "one needle endneedle", removed: "spare\n\nspare\n" },
    { name: "regex", extension: "txt", pattern: "/needle/", content: TEXT, lines: TEXT_LINES, edited: "spare\none replacement end\nspare\nreplacement", copied: "needleneedle", removed: "spare\none  end\nspare\n" },
    { name: "full-text", extension: "txt", pattern: "~needle", content: TEXT, lines: TEXT_LINES, edited: "spare\none replacement end\nspare\nreplacement", copied: "needleneedle", removed: "spare\none  end\nspare\n" },
    { name: "XPath", extension: "xml", pattern: "//item", content: "<root>\n<item>needle</item>\n<other/>\n<item>needle</item>\n</root>", lines: TEXT_LINES, edited: "<root>\nreplacement\n<other/>\nreplacement\n</root>", copied: "<item>needle</item><item>needle</item>", removed: "<root>\n\n<other/>\n\n</root>" },
    { name: "JSONPath", extension: "json", pattern: '$[?(@ == "needle")]', content: '[\n"needle",\n"spare",\n"needle"\n]', lines: TEXT_LINES, edited: '[\nreplacement,\n"spare",\nreplacement\n]', copied: '"needle""needle"', removed: '[\n,\n"spare",\n\n]' },
    { name: "graph definition", extension: "js", pattern: "&needle", content: "function needle() {}\nconst spare = 2;", lines: [1], edited: "replacement\nconst spare = 2;", copied: "function needle() {}", removed: "\nconst spare = 2;" },
    { name: "graph reference", extension: "js", pattern: "&<needle", content: "const value = needle(input); record(value);", lines: [1], edited: "const value = replacement(input); record(value);", copied: "needle", removed: "const value = (input); record(value);" },
    { name: "inline XPath element", extension: "xml", pattern: "//item", content: "<root><item>A</item><other>B</other></root>", lines: [1], edited: "<root>replacement<other>B</other></root>", copied: "<item>A</item>", removed: "<root><other>B</other></root>" },
    { name: "inline XPath text", extension: "xml", pattern: "//item/text()", content: "<root><item>A</item><other>B</other></root>", lines: [1], edited: "<root><item>replacement</item><other>B</other></root>", copied: "A", removed: "<root><item></item><other>B</other></root>" },
    { name: "JSON member value", extension: "json", pattern: "$.host", content: '{"host":"old","port":80}', lines: [1], edited: '{"host":replacement,"port":80}', copied: '"old"', removed: '{"host":,"port":80}' },
    { name: "XPath attribute", extension: "xml", pattern: "//item/@id", content: '<item id="old" class="other"/>', lines: [1], edited: '<item replacement class="other"/>', copied: 'id="old"', removed: '<item  class="other"/>' },
    { name: "XPath entity text", extension: "xml", pattern: "//item/text()", content: '<item>A &amp; B</item>', lines: [1], edited: '<item>replacement</item>', copied: 'A &amp; B', removed: '<item></item>' },
    { name: "HTML attribute", extension: "html", pattern: "//input/@value", content: '<input value="old"><p>stay</p>', lines: [1], edited: '<input replacement><p>stay</p>', copied: 'value="old"', removed: '<input ><p>stay</p>' },
    { name: "CSV cell", extension: "csv", pattern: "$[0].name", content: 'name,age\n"old",42', lines: [2], edited: 'name,age\nreplacement,42', copied: '"old"', removed: 'name,age\n,42' },
    { name: "INI value", extension: "ini", pattern: "$.main.name", content: '[main]\nname = old', lines: [2], edited: '[main]\nname = replacement', copied: 'old', removed: '[main]\nname = ' },
    { name: "dotenv value", extension: "env", pattern: "$.NAME", content: 'NAME="old" # keep', lines: [1], edited: 'NAME=replacement # keep', copied: '"old"', removed: 'NAME= # keep' },
    { name: "JSONL value", extension: "jsonl", pattern: "$[1].name", content: '{"name":"first"}\n{"name":"old"}', lines: [2], edited: '{"name":"first"}\n{"name":replacement}', copied: '"old"', removed: '{"name":"first"}\n{"name":}' },
    { name: "Markdown block", extension: "md", pattern: "//heading", content: 'before\n\n# Title\n\nafter', lines: [3], edited: 'before\n\nreplacement\n\nafter', copied: '# Title', removed: 'before\n\n\n\nafter' },
    { name: "diff hunk", extension: "diff", pattern: "//hunk", content: '--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n+new', lines: [3, 4, 5], edited: '--- a/f\n+++ b/f\nreplacement', copied: '@@ -1 +1 @@\n-old\n+new', removed: '--- a/f\n+++ b/f\n' },
    { name: "zero-width regex", extension: "txt", pattern: "/^/", content: 'first\nsecond', lines: [1, 2], edited: 'replacementfirst\nreplacementsecond', copied: '', removed: 'first\nsecond' },
] as const;

// {§read} {§edit-pattern} {§op-invariants} {§copy}
for (const specimen of cases) {
    for (const operation of ["FIND", "READ", "EDIT", "KILL", "COPY", "MOVE"] as const) {
        test(`{§mimetype-content} pattern composition: ${specimen.name} ${operation} selects the advertised content`, async () => {
            const db = await openMigrated();
            try {
                const env = await seedEnvelope(db, `patterns-${crypto.randomUUID()}`, { producer: "client" });
                const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
                const pathname = `/source.${specimen.extension}`;
                await new Workspace().edit(editStmt(urlPath("workspace", pathname), specimen.content), makeSchemeCtx({ db, ...env }));
                const source = `workspace://${pathname}`;
                const destination = "workspace:///selected.txt";
                const transfer = operation === "COPY" || operation === "MOVE";
                const findParsed = PlurnkParser.parseStatements(`\`\`\`FIND (${source}) ${specimen.pattern}\n\`\`\``);
                const findItem = findParsed.items[0];
                assert.equal(findItem?.kind, "statement");
                if (findItem?.kind !== "statement" || findItem.statement.op !== "FIND") throw new Error("Expected parsed FIND");
                const matcher = findItem.statement.matcher;
                const header = transfer
                    ? `${operation} (${source}) (${destination})`
                    : operation === "EDIT"
                        ? `${operation} (${source})`
                        : `${operation} (${source}) ${specimen.pattern}`;
                const parsed = PlurnkParser.parseStatements(`\`\`\`${header}\n${operation === "EDIT" ? "replacement\n" : ""}\`\`\``);
                assert.equal(parsed.items.length, 1, JSON.stringify(parsed));
                const [item] = parsed.items;
                assert.equal(item?.kind, "statement", JSON.stringify(parsed));
                if (item?.kind !== "statement") throw new Error("Expected one parsed operation");
                const statement = transfer && (item.statement.op === "COPY" || item.statement.op === "MOVE")
                    ? { ...item.statement, source: { ...item.statement.source, matcher } }
                    : item.statement.op === "EDIT"
                        ? { ...item.statement, matcher }
                        : item.statement;
                const result = await engine.dispatch({ ...env, statement, sequence: 1, origin: "client" });
                const body = async (path: string) => (await db.test_get_channel_by_pathname.get<{ content: string }>({ pathname: path, name: "body" }))?.content;
                const unchanged = operation === "KILL" && specimen.removed === specimen.content;
                assert.equal(result.status, transfer ? 201 : unchanged ? 304 : 200, JSON.stringify(result));
                const lines = specimen.content.split("\n");
                if (operation === "FIND") {
                    assert.deepEqual((result.results as { region: { startLine: number; endLine: number } }[])
                        .flatMap(({ region }) => Array.from({ length: region.endLine - region.startLine + 1 }, (_, index) => region.startLine + index)), specimen.lines);
                    assert.equal(await body(pathname), specimen.content);
                } else if (operation === "READ") {
                    assert.equal(result.content, specimen.lines.map((line) => lines[line - 1]).join("\n"));
                    assert.deepEqual(result.lineOrdinals, specimen.lines);
                    assert.equal(await body(pathname), specimen.content);
                } else if (operation === "EDIT") {
                    assert.equal(await body(pathname), specimen.edited);
                } else {
                    if (transfer) {
                        assert.equal(await body("/selected.txt"), specimen.copied);
                    }
                    assert.equal(await body(pathname), operation === "COPY" ? specimen.content : specimen.removed);
                }
            } finally {
                await db.close();
            }
        });
    }
}

for (const specimen of [
    { path: "source.md", content: "# Heading\n\nbody **strong** end", pattern: "//heading | //strong" },
    { path: "source.xml", content: "<root><item>value</item></root>", pattern: "$.type" },
]) for (const operation of ["EDIT", "KILL", "COPY", "MOVE"] as const) {
    test(`{§zero-width-column-one-insert} ${operation} refuses ${specimen.pattern} without partial writes`, async () => {
        const db = await openMigrated();
        try {
            const env = await seedEnvelope(db, `precision-${crypto.randomUUID()}`, { producer: "client" });
            const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
            const target = `workspace:///${specimen.path}`;
            await new Workspace().edit(editStmt(urlPath("workspace", `/${specimen.path}`), specimen.content), makeSchemeCtx({ db, ...env }));
            const transfer = operation === "COPY" || operation === "MOVE";
            const findParsed = PlurnkParser.parseStatements(`\`\`\`FIND (${target}) ${specimen.pattern}\n\`\`\``);
            const findItem = findParsed.items[0];
            if (findItem?.kind !== "statement" || findItem.statement.op !== "FIND") throw new Error(JSON.stringify(findParsed));
            const matcher = findItem.statement.matcher;
            const parsed = PlurnkParser.parseStatements(`\`\`\`${operation} (${target})${transfer ? " (workspace:///destination.txt)" : ` ${specimen.pattern}`}\n${operation === "EDIT" ? "replacement\n" : ""}\`\`\``);
            assert.equal(parsed.items[0]?.kind, "statement");
            const item = parsed.items[0];
            if (item?.kind !== "statement") throw new Error(JSON.stringify(parsed));
            const statement = transfer && (item.statement.op === "COPY" || item.statement.op === "MOVE")
                ? { ...item.statement, source: { ...item.statement.source, matcher } }
                : item.statement;
            const result = await engine.dispatch({ ...env, statement, sequence: 1, origin: "client" });
            assert.equal(result.status, 422, JSON.stringify(result));
            assert.match(String(result.problem?.type), /\/pattern-source-unlocated$/);
            const source = await db.test_get_channel_by_pathname.get<{ content: string }>({ pathname: `/${specimen.path}`, name: "body" });
            assert.equal(source?.content, specimen.content);
            assert.equal(await db.test_get_channel_by_pathname.get({ pathname: "/destination.txt", name: "body" }), undefined);
        } finally { await db.close(); }
    });
}
});

describe("pattern-dialects", () => {
// {§mimetype-query} {§find} — the pattern feature end to end, as the model
// drives it: one seeded corpus (markdown, JSON, XML, text), then one FIND per dialect and
// per cross-mapping, every answer read back from the dispatched rows. Regex carries its
// `matched` text, xpath selects markdown headings by level and by text, jsonpath walks the
// markdown deep tree, the universal mapping runs xpath over JSON and jsonpath over XML,
// an empty selection is 204, and an unbound xpath prefix is a 400 that names its dialect.





const GUIDE = "# Project\n\nIntro line.\n\n## Build\n\nRun npm ci.\nThen npm test.\n\n## Testing\n\nUse node --test.\n\n## Style\n\nDouble quotes.";
const CONFIG = "{\"items\":[{\"name\":\"alpha\",\"size\":3},{\"name\":\"beta\",\"size\":7}],\"host\":\"db.internal\"}";
const FEED = "<feed><item id=\"1\">alpha</item><item id=\"2\">beta</item></feed>";
const NOTES = "alpha line\nbeta line\nGAMMA line";

type Probe = { target: string; pattern: string; expect: (rx: string, status: number) => void };

const locations = (rx: string): number => {
    const m = /"matchLocationCount":(\d+)/.exec(rx);
    assert.ok(m, `matchLocationCount missing in ${rx.slice(0, 200)}`);
    return Number(m[1]);
};

const PROBES: Probe[] = [
    { target: "workspace:///notes.txt", pattern: "/^beta/m", expect: (rx, status) => {
        assert.equal(status, 200, rx.slice(0, 200));
        assert.match(rx, /"matched":"beta"/, "regex carries the matched text");
        assert.equal(locations(rx), 1);
    } },
    { target: "workspace:///notes.txt", pattern: "/gamma/i", expect: (rx, status) => {
        assert.equal(status, 200, rx.slice(0, 200));
        assert.match(rx, /"matched":"GAMMA"/, "regex flags apply");
    } },
    { target: "workspace:///notes.txt", pattern: "alpha*", expect: (rx, status) => {
        assert.equal(status, 200, rx.slice(0, 200));
        assert.match(rx, /"matched":"alpha line"/, "glob matches the whole line");
    } },
    { target: "workspace:///notes.txt", pattern: "/zeta/", expect: (_rx, status) => {
        assert.equal(status, 204, "no selection is 204");
    } },
    { target: "workspace:///docs/guide.md", pattern: "//heading[@level='2']", expect: (rx, status) => {
        assert.equal(status, 200, rx.slice(0, 200));
        assert.equal(locations(rx), 3, "three level-2 headings");
        assert.match(rx, /"startLine":5/);
        assert.match(rx, /"startLine":10/);
        assert.match(rx, /"startLine":14/);
    } },
    { target: "workspace:///docs/guide.md", pattern: "//heading[text='Testing']", expect: (rx, status) => {
        assert.equal(status, 200, rx.slice(0, 200));
        assert.equal(locations(rx), 1);
        assert.match(rx, /"startLine":10/, "the heading's own line is the location");
    } },
    { target: "workspace:///docs/guide.md", pattern: "//heading[@pk:level='1']", expect: (rx, status) => {
        assert.equal(status, 200, rx.slice(0, 200));
        assert.equal(locations(rx), 1, "the provenance prefix is bound");
    } },
    { target: "workspace:///docs/guide.md", pattern: "//heading[@zz:level='2']", expect: (rx, status) => {
        assert.equal(status, 400, rx.slice(0, 200));
        assert.match(rx, /xpath/, "the refusal names the dialect");
    } },
    { target: "workspace:///docs/guide.md", pattern: "$..[?(@.type=='heading' && @.level==2)]", expect: (rx, status) => {
        assert.equal(status, 200, rx.slice(0, 200));
        assert.equal(locations(rx), 3, "jsonpath walks the markdown deep tree");
        assert.match(rx, /"locator":"\$\['children'\]\[8\]","region":\{"startLine":10/, "a structural row keeps its locator and the heading's line");
    } },
    { target: "workspace:///data/config.json", pattern: "$.items[*].name", expect: (rx, status) => {
        assert.equal(status, 200, rx.slice(0, 200));
        assert.equal(locations(rx), 2);
        assert.match(rx, /"locator":"\$\['items'\]\[0\]\['name'\]","region":\{"startLine":1,"startColumn":19,"endLine":1,"endColumn":26\}/, "exact columns of the first value");
        assert.match(rx, /"locator":"\$\['items'\]\[1\]\['name'\]"/);
    } },
    { target: "workspace:///data/config.json", pattern: "//items/name", expect: (rx, status) => {
        assert.equal(status, 200, rx.slice(0, 200));
        assert.equal(locations(rx), 2, "xpath over JSON through the deep-xml projection");
        assert.match(rx, /"locator":"\(\/\/items\/name\)\[1\]","region":\{"startLine":1,"startColumn":19,"endLine":1,"endColumn":26\}/, "xpath rows carry the same exact columns as jsonpath rows");
        assert.match(rx, /"locator":"\(\/\/items\/name\)\[2\]","region":\{"startLine":1,"startColumn":45,"endLine":1,"endColumn":51\}/);
    } },
    { target: "workspace:///data/feed.xml", pattern: "//item[@id='2']", expect: (rx, status) => {
        assert.equal(status, 200, rx.slice(0, 200));
        assert.equal(locations(rx), 1);
        assert.match(rx, /"locator":"\/\/item\[@id='2'\]"/, "xpath over XML keeps its locator");
    } },
    { target: "workspace:///docs/guide.md", pattern: "&Project", expect: (rx, status) => {
        assert.notEqual(status, 503, `a graph FIND settles the index instead of refusing: ${rx.slice(0, 200)}`);
        assert.ok(status === 200 || status === 204, `graph FIND answers, got ${status}`);
    } },
    { target: "workspace:///data/feed.xml", pattern: "$..id", expect: (rx, status) => {
        assert.equal(status, 200, rx.slice(0, 200));
        assert.equal(locations(rx), 2, "jsonpath over XML through the deep-json projection (attributes are keys)");
    } },
];

test("{§mimetype-query}: every pattern dialect answers the model from one seeded corpus", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const seed = [
        `\`\`\`\`EDIT (workspace:///docs/guide.md)
${GUIDE}
\`\`\`\``,
        `\`\`\`\`EDIT (workspace:///data/config.json)
${CONFIG}
\`\`\`\``,
        `\`\`\`\`EDIT (workspace:///data/feed.xml)
${FEED}
\`\`\`\``,
        `\`\`\`\`EDIT (workspace:///notes.txt)
${NOTES}
\`\`\`\``,
    ].join("\n\n");
    const finds = PROBES.map(({ target, pattern }) => `\`\`\`\`FIND (${target}) ${pattern}\`\`\`\``).join("\n\n");
    const mock = new Mock({ contextWindow: 65536, responses: [
        makeMockResponse(`${seed}

\`\`\`\`NOTE
seeded
\`\`\`\``, 10),
        makeMockResponse(`${finds}

\`\`\`\`NOTE
searched
\`\`\`\``, 10),
        makeMockResponse("````SEND [200]\ndone\n````", 10),
    ] });
    await withDaemon(mock, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "pattern-dialects" });
            const { finalStatus, loopId } = await runLoopToTerminal(ws, 2, { prompt: "go" });
            const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; status_rx: number; tx: string; rx: string }>({ loop_id: loopId });
            const edits = rows.filter((r) => r.op === "EDIT" && r.origin === "model");
            assert.deepEqual(edits.map((r) => r.status_rx), [201, 201, 201, 201], "the corpus seeded");
            const findRows = rows.filter((r) => r.op === "FIND" && r.origin === "model");
            assert.equal(findRows.length, PROBES.length, "one dispatched row per FIND");
            for (const [index, probe] of PROBES.entries()) {
                const row = findRows[index];
                const tx = JSON.parse(row.tx) as { target?: { raw?: string }; matcher?: { raw?: string } };
                assert.equal(tx.target?.raw, probe.target, `probe ${index + 1} target`);
                assert.equal(tx.matcher?.raw, probe.pattern, `probe ${index + 1} pattern`);
                probe.expect(row.rx, row.status_rx);
            }
            assert.equal(finalStatus, 200);
        } finally { ws.close(); }
    });
});
});

