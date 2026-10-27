import test, { describe } from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import File from "../../src/schemes/File.ts";
import GitMembership from "../../src/core/git-membership.ts";
import MembershipMaterialization from "../../src/core/MembershipMaterialization.ts";
import EntryCrud from "../../src/schemes/_entry-crud.ts";
import LogEntryProjection from "../../src/core/LogEntryProjection.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { type LineMarker, isExecutionOp, type FindStatement, type MatcherBody, type ParsedPath, type ReadStatement } from "@plurnk/plurnk-contracts";
import { MimetypeClassifier, type ResolvedEditStatement } from "@plurnk/plurnk-schemes";
import { hermeticGitEnv } from "../../src/core/git-env.ts";
import { DEFAULT_MIMETYPES, makeSchemeCtx, readThroughScheme } from "./_scheme.ts";
import { insertLoop, insertOperationTurn, insertTurn, insertSession, insertWorkspace, openMigrated, rootWorkspace } from "./_db.ts";
import { serverProposals } from "./_approval.ts";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, connect, withDaemon, runLoopToTerminal } from "./_rpc.ts";
import { makeMockResponse, fixtureExecutors, makeRawMockResponse } from "./_mock.ts";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { type Db } from "../../src/core/Db.ts";
import { type PlurnkSchemeContext } from "../../src/core/scheme-types.ts";
import { resourcePaths } from "./_find.ts";


describe("file-creation-contract", () => {
// File creation is one producer-neutral transaction: scope + membership policy admit the
// proposal, exclusive disk creation lands it, and Git or an inspectable pick incorporates it.
// These specimens cover the contract matrices in {§fs-write-surface} and
// {§fs-write-surface}, rather than one caller's implementation path.



















const execFileP = promisify(execFile);
const replaceAll: LineMarker = { marks: [1, -1] };
const edit = (pathname: string, body: string, lineMarker: LineMarker | null = null): ResolvedEditStatement => ({
    metadata: null,
    op: "EDIT",
    aside: null,
    target: { kind: "local", raw: pathname },
    lineMarker,
    body,
    matcher: null, position: { line: 1, column: 1 },
});

type Constraint = { effect: string; glob: string; source?: string };

const constraints = (db: Awaited<ReturnType<typeof openMigrated>>, workspaceId: number) =>
    db.crud_list_workspace_constraints.all<Constraint>({ workspace_id: workspaceId });

const withWorkspace = async (
    fn: (fixture: {
        root: string;
        outside: string;
        file: File;
        db: Awaited<ReturnType<typeof openMigrated>>;
        workspaceId: number;
        ctx: ReturnType<typeof makeSchemeCtx>;
    }) => Promise<void>,
): Promise<void> => {
    const parent = await mkdtemp(join(tmpdir(), "plurnk-create-contract-"));
    const root = join(parent, "root");
    const outside = join(parent, "outside");
    await Promise.all([mkdir(root), mkdir(outside)]);
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `create-${crypto.randomUUID()}`);
        await rootWorkspace(db, workspaceId, root);
        const sessionId = await insertSession(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId, mimetypes: DEFAULT_MIMETYPES });
        await fn({ root, outside, file: new File(), db, workspaceId, ctx });
    } finally {
        await db.close();
        await rm(parent, { recursive: true, force: true });
    }
};

const acceptCreate = async (
    file: File,
    ctx: ReturnType<typeof makeSchemeCtx>,
    pathname: string,
    body: string = "created\n",
) => {
    const proposed = await file.edit(edit(pathname, body), ctx);
    assert.equal(proposed.status, 202, `${pathname} reaches proposal review`);
    const applied = await file.applyResolution({ attrs: proposed.attrs as never, metadata: null }, ctx);
    assert.equal(applied.status, 200, `${pathname} lands completely`);
    return applied;
};

test("{§fs-write-surface}: every runtime producer completes the same reviewed creation", async () => {
    await withWorkspace(async ({ root, db, workspaceId, ctx }) => {
        const loopId = await insertLoop(db, ctx.sessionId, 1, "producer-neutral-create");
        const engine = new Engine({
            db,
            schemes: new SchemeRegistry(),
            mimetypes: DEFAULT_MIMETYPES,
            weigh: ctx.weigh,
        });
        for (const [index, origin] of (["model", "client", "_plurnk"] as const).entries()) {
            const turnId = origin === "model"
                ? await insertTurn(db, loopId, index + 1)
                : await insertOperationTurn(db, loopId, index + 1, origin);
            let announce!: (logEntryId: number) => void;
            const announced = new Promise<number>((res) => { announce = res; });
            const dispatch = engine.dispatch({
                statement: edit(`${origin}.md`, `${origin}\n`),
                workspaceId,
                sessionId: ctx.sessionId,
                loopId,
                turnId,
                sequence: 1,
                origin,
                onDispatch: announce,
            });
            engine.resolveProposal(await announced, { decision: "accept" });
            assert.equal((await dispatch).status, 200, `${origin} crosses review and the complete creation transaction`);
            assert.equal(await readFile(join(root, `${origin}.md`), "utf8"), `${origin}\n`);
        }
        assert.deepEqual(await constraints(db, workspaceId), [
            { effect: "include", glob: "_plurnk.md", source: "create" },
            { effect: "include", glob: "client.md", source: "create" },
            { effect: "include", glob: "model.md", source: "create" },
        ]);
    });
});

test("{§fs-write-surface} {§fs-write-surface}: a naked non-Git workspace create becomes an exact generated pick", async () => {
    await withWorkspace(async ({ root, file, db, workspaceId, ctx }) => {
        await acceptCreate(file, ctx, "fresh.md");
        assert.equal(await readFile(join(root, "fresh.md"), "utf8"), "created\n");
        assert.deepEqual(await constraints(db, workspaceId), [
            { effect: "include", glob: "fresh.md", source: "create" },
        ]);
        const member = await db.test_get_origin.get<{ membership_origin: string | null }>({
            workspace_id: workspaceId,
            pathname: "fresh.md",
        });
        assert.equal(member?.membership_origin, "constraint");
        const read = await EntryCrud.readEntry(
            { authority: "", pathname: "fresh.md" },
            ctx,
            "file",
        );
        assert.equal(read.status, 200, "the creating workspace can immediately address what it wrote");
    });
});

test("{§fs-write-surface}: an active Git create is incorporated by an exact generated pick and never staged", async () => {
    await withWorkspace(async ({ root, file, db, workspaceId, ctx }) => {
        await execFileP("git", ["init", "-q"], { cwd: root, env: hermeticGitEnv() });
        await acceptCreate(file, ctx, "tracked.md");
        await assert.rejects(
            execFileP("git", ["ls-files", "--error-unmatch", "--", "tracked.md"], { cwd: root, env: hermeticGitEnv() }),
            "Plurnk never runs `git add`: the created file stays untracked ({§membership})",
        );
        assert.deepEqual(await constraints(db, workspaceId), [
            { effect: "include", glob: "tracked.md", source: "create" },
        ], "the exact generated pick is the incorporation ({§membership})");
        const member = await db.test_get_origin.get<{ membership_origin: string | null }>({
            workspace_id: workspaceId,
            pathname: "tracked.md",
        });
        assert.equal(member?.membership_origin, "constraint");
    });
});

test("{§fs-write-surface}: ignore, hide, and view refuse automatic creation", async (t) => {
    await t.test("{§fs-write-surface} active Git ignore requires an explicit pick", async () => {
        await withWorkspace(async ({ root, file, ctx }) => {
            await execFileP("git", ["init", "-q"], { cwd: root, env: hermeticGitEnv() });
            await writeFile(join(root, ".gitignore"), "ignored.md\n");
            const result = await file.edit(edit("ignored.md", "secret\n"), ctx);
            assert.equal(result.status, 403);
            await assert.rejects(stat(join(root, "ignored.md")));
        });
    });

    await t.test("{§fs-write-surface} an exclusion refuses creation", async () => {
        await withWorkspace(async ({ root, file, db, workspaceId, ctx }) => {
            await db.crud_insert_family_workspace_constraint.run({ workspace_id: workspaceId, effect: "exclude", glob: "blocked.md", source: "members" });
            const result = await file.edit(edit("blocked.md", "blocked\n"), ctx);
            assert.equal(result.status, 403);
            await assert.rejects(stat(join(root, "blocked.md")));
        });
    });
});

test("{§fs-write-surface}: a member definition overrides Git ignore and leaves no creation record", async () => {
    await withWorkspace(async ({ root, file, db, workspaceId, ctx }) => {
        await execFileP("git", ["init", "-q"], { cwd: root, env: hermeticGitEnv() });
        await writeFile(join(root, ".gitignore"), "ignored.md\n");
        await db.crud_insert_family_workspace_constraint.run({ workspace_id: workspaceId, effect: "include", glob: "ignored.md", source: "members" });
        await acceptCreate(file, ctx, "ignored.md");
        assert.deepEqual(await constraints(db, workspaceId), [
            { effect: "include", glob: "ignored.md", source: "members" },
        ]);
        const member = await db.test_get_origin.get<{ membership_origin: string | null }>({
            workspace_id: workspaceId,
            pathname: "ignored.md",
        });
        assert.equal(member?.membership_origin, "constraint");
        await assert.rejects(execFileP("git", ["ls-files", "--error-unmatch", "--", "ignored.md"], {
            cwd: root,
            env: hermeticGitEnv(),
        }));
    });
});

test("{§fs-namespace}: a member definition supersedes Git and cleanly yields it back", async () => {
    await withWorkspace(async ({ root, db, workspaceId, ctx }) => {
        await execFileP("git", ["init", "-q"], { cwd: root, env: hermeticGitEnv() });
        await writeFile(join(root, "dual.md"), "dual\n");
        await execFileP("git", ["add", "--", "dual.md"], { cwd: root, env: hermeticGitEnv() });
        await GitMembership.resolveGitMembership(db, workspaceId, ctx.signal);
        const origin = () => db.test_get_origin.get<{ membership_origin: string | null }>({
            workspace_id: workspaceId,
            pathname: "dual.md",
        });
        assert.equal((await origin())?.membership_origin, "git");

        await db.crud_insert_family_workspace_constraint.run({ workspace_id: workspaceId, effect: "include", glob: "dual.md", source: "members" });
        await GitMembership.resolveGitMembership(db, workspaceId, ctx.signal);
        assert.equal((await origin())?.membership_origin, "constraint", "a member definition owns the represented grant");

        await db.crud_delete_family_workspace_constraints.run({ workspace_id: workspaceId });
        await GitMembership.resolveGitMembership(db, workspaceId, ctx.signal);
        assert.equal((await origin())?.membership_origin, "git", "removing the definition restores Git ownership");
    });
});

test("{§fs-write-surface}: service and workspace scopes compose monotonically", async (t) => {
    const previous = process.env.PLURNK_SERVICE_FILE_CREATE_SCOPE;
    t.after(() => {
        if (previous === undefined) delete process.env.PLURNK_SERVICE_FILE_CREATE_SCOPE;
        else process.env.PLURNK_SERVICE_FILE_CREATE_SCOPE = previous;
    });

    await t.test("{§fs-write-surface} none denies a new root file without affecting an existing member edit", async () => {
        process.env.PLURNK_SERVICE_FILE_CREATE_SCOPE = "none";
        await withWorkspace(async ({ root, file, db, workspaceId, ctx }) => {
            const denied = await file.edit(edit("new.md", "new\n"), ctx);
            assert.equal(denied.status, 403);

            await writeFile(join(root, "existing.md"), "before\n");
            await db.crud_register_workspace_member.get({
                workspace_id: workspaceId,
                scheme: "file",
                authority: "",
                pathname: "existing.md",
                membership_origin: "constraint",
            });
            await MembershipMaterialization.materializeMember("existing.md", root, ctx, new Map());
            const existing = await file.edit(edit("existing.md", "after\n", replaceAll), ctx);
            assert.equal(existing.status, 202, "the creation ceiling does not disable existing-member writes");
        });
    });

    await t.test("{§fs-write-surface} a workspace cannot widen root to namespace", async () => {
        process.env.PLURNK_SERVICE_FILE_CREATE_SCOPE = "root";
        await withWorkspace(async ({ outside, file, db, workspaceId, ctx }) => {
            await db.test_set_workspace_settings.run({
                id: workspaceId,
                settings: JSON.stringify({ fileCreateScope: "namespace" }),
            });
            const key = `../${basename(outside)}/outside.md`;
            const result = await file.edit(edit(key, "outside\n"), ctx);
            assert.equal(result.status, 403);
        });
    });

    await t.test("{§fs-write-surface} namespace admits an outside create and exact-picks it", async () => {
        process.env.PLURNK_SERVICE_FILE_CREATE_SCOPE = "namespace";
        await withWorkspace(async ({ outside, file, db, workspaceId, ctx }) => {
            const key = `../${basename(outside)}/outside.md`;
            await acceptCreate(file, ctx, key, "outside\n");
            assert.equal(await readFile(join(outside, "outside.md"), "utf8"), "outside\n");
            assert.deepEqual(await constraints(db, workspaceId), [
                { effect: "include", glob: key, source: "create" },
            ]);
        });
    });
});

test("{§fs-write-surface}: an in-root symlinked parent cannot bypass the root ceiling", async () => {
    await withWorkspace(async ({ root, outside, file, ctx }) => {
        await symlink(outside, join(root, "escape"), "dir");
        const result = await file.edit(edit("escape/smuggled.md", "outside\n"), ctx);
        assert.equal(result.status, 403);
        assert.equal(result.problem?.type, "https://problems.plurnk.xyz/scheme/file/path-outside-workspace");
        await assert.rejects(stat(join(outside, "smuggled.md")));
    });
});

test("{§fs-write-surface}: approval rejects a parent symlink swapped after proposal", async () => {
    await withWorkspace(async ({ root, outside, file, db, workspaceId, ctx }) => {
        const parent = join(root, "pending");
        await mkdir(parent);
        const proposed = await file.edit(edit("pending/escaped.md", "outside\n"), ctx);
        assert.equal(proposed.status, 202);

        await rm(parent, { recursive: true });
        await symlink(outside, parent, "dir");
        const applied = await file.applyResolution({ attrs: proposed.attrs as never, metadata: null }, ctx);

        assert.equal(applied.status, 403);
        assert.equal(applied.problem?.type, "https://problems.plurnk.xyz/scheme/file/path-outside-workspace");
        await assert.rejects(stat(join(outside, "escaped.md")));
        assert.deepEqual(await constraints(db, workspaceId), []);
    });
});

test("{§fs-write-surface}: generated picks follow deletion while explicit picks survive it", async () => {
    await withWorkspace(async ({ file, db, workspaceId, ctx }) => {
        await acceptCreate(file, ctx, "generated.md");
        const generatedDelete = await file.deleteEntry("generated.md", ctx);
        assert.equal(generatedDelete.status, 202);
        assert.equal((await file.applyResolution({ attrs: generatedDelete.attrs as never, metadata: null }, ctx)).status, 200);
        assert.deepEqual(await constraints(db, workspaceId), [], "KILL removes creation provenance with its file");

        await db.crud_insert_family_workspace_constraint.run({ workspace_id: workspaceId, effect: "include", glob: "explicit.md", source: "members" });
        await acceptCreate(file, ctx, "explicit.md");
        const explicitDelete = await file.deleteEntry("explicit.md", ctx);
        assert.equal(explicitDelete.status, 202);
        assert.equal((await file.applyResolution({ attrs: explicitDelete.attrs as never, metadata: null }, ctx)).status, 200);
        assert.deepEqual(await constraints(db, workspaceId), [
            { effect: "include", glob: "explicit.md", source: "members" },
        ], "automatic lifecycle never retracts a projected definition");
    });
});

test("{§fs-write-surface}: a member definition over a created path never overwrites the creation record", async () => {
    await withWorkspace(async ({ file, db, workspaceId, ctx }) => {
        await acceptCreate(file, ctx, "promoted.md");
        await db.crud_insert_family_workspace_constraint.run({ workspace_id: workspaceId, effect: "include", glob: "promoted.md", source: "members" });
        assert.deepEqual(await constraints(db, workspaceId), [
            { effect: "include", glob: "promoted.md", source: "create" },
        ], "the creation record stays as it is");
        const deletion = await file.deleteEntry("promoted.md", ctx);
        assert.equal(deletion.status, 202);
        assert.equal((await file.applyResolution({ attrs: deletion.attrs as never, metadata: null }, ctx)).status, 200);
        assert.deepEqual(await constraints(db, workspaceId), [], "deleting the file retires its record; the definition still lives in the members family");
    });
});

test("{§fs-write-surface}: exclusions mask creation records without consuming their provenance", async (t) => {
    await t.test("{§fs-write-surface} removing the exclusion restores the created member", async () => {
        await withWorkspace(async ({ file, db, workspaceId, ctx }) => {
            await acceptCreate(file, ctx, "masked.md");
            await db.crud_insert_family_workspace_constraint.run({ workspace_id: workspaceId, effect: "exclude", glob: "masked.md", source: "members" });
            await GitMembership.resolveGitMembership(db, workspaceId, ctx.signal);
            const hidden = await db.test_get_origin.get({ workspace_id: workspaceId, pathname: "masked.md" });
            assert.equal(hidden, undefined, "an exclusion removes the addressable entry");
            assert.deepEqual(await constraints(db, workspaceId), [
                { effect: "exclude", glob: "masked.md", source: "members" },
                { effect: "include", glob: "masked.md", source: "create" },
            ], "an exclusion masks rather than retracts creation provenance");

            await db.crud_delete_family_workspace_constraints.run({ workspace_id: workspaceId });
            await GitMembership.resolveGitMembership(db, workspaceId, ctx.signal);
            const restored = await db.test_get_origin.get<{ membership_origin: string | null }>({
                workspace_id: workspaceId,
                pathname: "masked.md",
            });
            assert.equal(restored?.membership_origin, "constraint");
        });
    });

    await t.test("{§fs-write-surface} a later Git-ignore rule is likewise reversible", async () => {
        await withWorkspace(async ({ root, file, db, workspaceId, ctx }) => {
            await acceptCreate(file, ctx, "ignored-later.md");
            await execFileP("git", ["init", "-q"], { cwd: root, env: hermeticGitEnv() });
            await writeFile(join(root, ".gitignore"), "ignored-later.md\n");
            assert.deepEqual(
                await GitMembership.indexGitMembership(ctx),
                [],
                "a policy mask is not narrated as an ambient file deletion",
            );
            const hidden = await db.test_get_origin.get({ workspace_id: workspaceId, pathname: "ignored-later.md" });
            assert.equal(hidden, undefined);
            assert.deepEqual((await constraints(db, workspaceId)).filter(({ source }) => source === "create"), [
                { effect: "include", glob: "ignored-later.md", source: "create" },
            ]);

            await writeFile(join(root, ".gitignore"), "");
            await GitMembership.resolveGitMembership(db, workspaceId, ctx.signal);
            const restored = await db.test_get_origin.get<{ membership_origin: string | null }>({
                workspace_id: workspaceId,
                pathname: "ignored-later.md",
            });
            assert.equal(restored?.membership_origin, "constraint");
        });
    });
});

test("{§fs-write-surface}: reconciliation removes stale generated provenance with an ambient deletion", async () => {
    await withWorkspace(async ({ root, file, db, workspaceId, ctx }) => {
        await acceptCreate(file, ctx, "ambient.md");
        await rm(join(root, "ambient.md"));
        await GitMembership.resolveGitMembership(db, workspaceId, ctx.signal);
        assert.deepEqual(await constraints(db, workspaceId), []);
        const member = await db.test_get_origin.get<{ membership_origin: string | null }>({
            workspace_id: workspaceId,
            pathname: "ambient.md",
        });
        assert.equal(member, undefined);
    });
});

test("{§fs-write-surface}: generated exact picks preserve literal glob metacharacters", async () => {
    await withWorkspace(async ({ root, file, db, workspaceId, ctx }) => {
        const pathname = "literal[1]*?.md";
        await acceptCreate(file, ctx, pathname);
        await GitMembership.resolveGitMembership(db, workspaceId, ctx.signal);
        assert.equal(await readFile(join(root, pathname), "utf8"), "created\n");
        assert.deepEqual(await constraints(db, workspaceId), [
            { effect: "include", glob: pathname, source: "create" },
        ]);
        const member = await db.test_get_origin.get<{ membership_origin: string | null }>({
            workspace_id: workspaceId,
            pathname,
        });
        assert.equal(member?.membership_origin, "constraint");
    });
});

test("{§fs-write-surface}: failed incorporation rolls disk and entry state back together", async (t) => {
    await withWorkspace(async ({ root, file, db, workspaceId, ctx }) => {
        t.mock.method(console, "error", () => {});
        t.mock.method(db.crud_insert_generated_workspace_constraint, "run", async () => {
            throw new Error("injected constraint persistence failure");
        });
        const proposed = await file.edit(edit("rollback.md", "transient\n"), ctx);
        assert.equal(proposed.status, 202);
        const applied = await file.applyResolution({ attrs: proposed.attrs as never, metadata: null }, ctx);
        assert.equal(applied.status, 500);
        assert.equal(applied.problem?.type, "https://problems.plurnk.xyz/scheme/file/creation-incorporation-failed");
        await assert.rejects(stat(join(root, "rollback.md")));
        assert.deepEqual(await constraints(db, workspaceId), []);
        const member = await db.test_get_origin.get<{ membership_origin: string | null }>({
            workspace_id: workspaceId,
            pathname: "rollback.md",
        });
        assert.equal(member, undefined);
    });
});
});

describe("Engine.packet-no-host-paths", () => {
// {§fs-namespace} Execution receipts do not repeat the default working directory.












const execFileP = promisify(execFile);

test("{§fs-namespace} execution receipts and failed targets do not expose a redundant absolute working directory", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const root = await realpath(await mkdtemp(join(tmpdir(), "plurnk-namespace-")));
    try {
        const env = hermeticGitEnv();
        await execFileP("git", ["init", "-q"], { cwd: root, env });
        await execFileP("git", ["config", "user.email", "fixture@plurnk.invalid"], { cwd: root, env });
        await execFileP("git", ["config", "user.name", "t"], { cwd: root, env });
        await writeFile(join(root, "doc.md"), "one\n");
        await execFileP("git", ["add", "doc.md"], { cwd: root, env });
        await execFileP("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--no-verify", "-q", "-m", "seed"], { cwd: root, env });

        // A targetless command (its receipt names the root — the default), a command whose
        // target does not resolve, then a conclusion.
        const mock = new Mock({ contextWindow: 32768, responses: [
            makeMockResponse("````sh\nprintf ok\n````\n\n````sh (cwd: /nowhere)\nprintf never\n````\n\n````NOTE\nran\n````", 50),
            makeMockResponse("````SEND [200]\ndone\n````", 50),
        ] });
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "namespace", projectRoot: root });
                const result = await runLoopToTerminal(ws, 2, { prompt: "run" });
                assert.equal(result.result.status, 200);
                const texts: string[] = [];
                for (const id of result.turnIds ?? []) {
                    const row = await db.test_get_packet.get<{ packet: string }>({ id });
                    if (row?.packet) texts.push(row.packet);
                }
                assert.ok(texts.length >= 2, `every turn's packet is inspected; got ${texts.length}`);
                const rows = await db.engine_render_log.all<{ op: string; status_rx: number; rx: string }>({ session_id: result.modelSessionId! });
                const execs = rows.filter(({ op }) => isExecutionOp(op));
                assert.deepEqual(execs.map(({ status_rx }) => status_rx).toSorted((x, y) => x - y), [200, 400], "one command ran, one target was refused");
                for (const text of texts) {
                    assert.doesNotMatch(text, new RegExp(root.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")), "the host root never appears in what the model sees");
                }
            } finally { ws.close(); }
        });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
});

describe("File.read", () => {
const PAGE = Number(process.env.PLURNK_SERVICE_PREVIEW_LINES); // {§packet} — the first page a markerless retrieval is

const filePath = (pathname: string): ParsedPath => ({ kind: "local", raw: pathname });

const readStmt = (target: ParsedPath | null, opts: { lineMarker?: ReadStatement["lineMarker"]; } = {}): ReadStatement => ({
    metadata: null,
    op: "READ", aside: null,
    target,
    lineMarker: opts.lineMarker ?? null, matcher: null, body: null,
    position: { line: 1, column: 1 },
});

const findStmt = (target: ParsedPath | null, matcher: MatcherBody | null = null): FindStatement => ({
    metadata: null,
    op: "FIND", aside: null, target, lineMarker: null, matcher, body: null,  position: { line: 1, column: 1 },
});

const readFileScheme = (statement: ReadStatement, ctx: PlurnkSchemeContext) =>
    readThroughScheme("file", null, statement, ctx);

// Parse a single op the way production does, so a bare path carries its REAL parsed shape
// (a LocalPath {kind:"local"}), not a hand-built UrlPath that hides the kind the model emits.
const parseRead = (dsl: string): ReadStatement => {
    const found = PlurnkParser.parse(dsl, { executors: fixtureExecutors(dsl) }).items
        .find((i) => i.kind === "statement" && i.statement.op === "READ");
    if (found === undefined) throw new Error(`no READ parsed from: ${dsl}`);
    return (found as { kind: "statement"; statement: ReadStatement }).statement;
};

const parseFind = (dsl: string): FindStatement => {
    const found = PlurnkParser.parse(dsl, { executors: fixtureExecutors(dsl) }).items
        .find((i) => i.kind === "statement" && i.statement.op === "FIND");
    if (found === undefined) throw new Error(`no FIND parsed from: ${dsl}`);
    return (found as { kind: "statement"; statement: FindStatement }).statement;
};

// Materialize a file as a readable member — mirrors what the git-membership pass
// does in production: read disk content into the entry's body channel via
// writeEntry (the entry-write paradigm). Entry-backed File.read serves THIS entry,
// never a disk read. Root comes from the workspace's project_root, like production.
const addMember = async (ctx: PlurnkSchemeContext, pathname: string): Promise<void> => {
    if (ctx.mimetypes === undefined) throw new Error("addMember: ctx.mimetypes required");
    const row = await ctx.db.envelope_get_workspace.get<{ project_root: string }>({ id: ctx.workspaceId });
    const canonical = join(row?.project_root ?? "", pathname);
    const mimetype = MimetypeClassifier.normalizeAutoText(await ctx.mimetypes.detect({ path: canonical }));
    const content = await readFile(canonical, "utf8");
    // {§fs-namespace} File entries retain their project-relative key.
    await EntryCrud.writeEntry({ authority: "", pathname: pathname }, { channels: { body: { content, mimetype } } }, ctx, "file");
};

// Set up a workspace whose project_root points at a fresh temp directory,
// build a real PlurnkSchemeContext against it, run the test, clean up.
// The workspace root is per-workspace, sourced from workspaces.project_root.
const withWorkspaceRoot = async (fn: (root: string, ctx: PlurnkSchemeContext, db: Db) => Promise<void>): Promise<void> => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-file-"));
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `file-test-${crypto.randomUUID()}`);
        await db.test_set_workspace_project_root.run({ id: workspaceId, project_root: root });
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1);
        const turnId = await insertTurn(db, loopId, 1, 102);
        const ctx: PlurnkSchemeContext = {
            db, workspaceId, sessionId, loopId, turnId,
            writer: "model", signal: undefined, mimetypes: DEFAULT_MIMETYPES, weigh: (t: string) => Math.ceil(t.length / 4),
        };
        await fn(root, ctx, db);
    } finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
};

// Build a ctx whose workspace has NULL project_root, to exercise the
// "headless / no workspace" branch.
const withHeadlessWorkspace = async (fn: (ctx: PlurnkSchemeContext, db: Db) => Promise<void>): Promise<void> => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `headless-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1);
        const turnId = await insertTurn(db, loopId, 1, 102);
        const ctx: PlurnkSchemeContext = {
            db, workspaceId, sessionId, loopId, turnId,
            writer: "model", signal: undefined, mimetypes: DEFAULT_MIMETYPES, weigh: (t: string) => Math.ceil(t.length / 4),
        };
        await fn(ctx, db);
    } finally { await db.close(); }
};

test("{§packet} File.read: read existing file inside workspace → 200 + content + text/markdown", async () => {
    // plurnk-service's text primitive is text/markdown — File.read of a
    // .txt with no specific handler falls back to it (any plain text is
    // valid markdown; auto-derived text mimetype is never text/plain).
    await withWorkspaceRoot(async (root, ctx) => {
        await writeFile(join(root, "hello.txt"), "Paris is the capital of France.\n");
        await addMember(ctx, "hello.txt");
        const result = await readFileScheme(readStmt(filePath("hello.txt")), ctx);
        assert.equal(result.status, 200);
        assert.equal(result.content, "Paris is the capital of France.\n");
        assert.equal(result.mimetype, "text/markdown");
    });
});

test("{§packet} File.read: nested path inside workspace works", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        await mkdir(join(root, "docs"));
        await writeFile(join(root, "docs", "readme.md"), "# Doc\n");
        await addMember(ctx, "docs/readme.md");
        const result = await readFileScheme(readStmt(filePath("docs/readme.md")), ctx);
        assert.equal(result.status, 200);
        assert.equal(result.content, "# Doc\n");
    });
});

test("{§mimetype-parser-coordinates}: READ preserves an indented Python reference specimen", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        const content = "                    kwargs[key] = converter.to_python(value)";
        await writeFile(join(root, "reference.py"), content);
        await EntryCrud.writeEntry({ authority: "", pathname: "reference.py" }, {
            channels: { body: { content, mimetype: "text/x-python" } },
        }, ctx, "file");
        const result = await readFileScheme(parseRead("````READ (reference.py) <1,-1>\n````"), ctx);
        assert.equal(result.status, 200);
        assert.equal(result.content, content);
        assert.equal(result.mimetype, "text/markdown");
    });
});

test("{§packet} File.read: missing file → 404", async () => {
    await withWorkspaceRoot(async (_root, ctx) => {
        const result = await readFileScheme(readStmt(filePath("missing.txt")), ctx);
        assert.equal(result.status, 404);
        assert.equal(result.content, null);
    });
});

test("{§packet} File.read: workspace escape via .. → 403 or 404", async () => {
    await withWorkspaceRoot(async (_root, ctx) => {
        const outside = await mkdtemp(join(tmpdir(), "plurnk-outside-"));
        try {
            await writeFile(join(outside, "secret.txt"), "shouldnt-see");
            const result = await readFileScheme(readStmt(filePath(`../${outside.split("/").pop()}/secret.txt`)), ctx);
            assert.ok(result.status === 403 || result.status === 404, `expected 403 or 404, got ${result.status}`);
        } finally { await rm(outside, { recursive: true, force: true }); }
    });
});

test("{§packet} File.read: symlink pointing outside workspace → 404 (never a member)", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        const outside = await mkdtemp(join(tmpdir(), "plurnk-outside-"));
        try {
            await writeFile(join(outside, "secret.txt"), "shouldnt-see");
            await symlink(join(outside, "secret.txt"), join(root, "link-to-secret"));
            const result = await readFileScheme(readStmt(filePath("link-to-secret")), ctx);
            // Containment lives at the materialize/edit disk edges: an outside-root
            // symlink is never materialized → no entry → 404.
            assert.equal(result.status, 404, "non-member (outside-root symlink) → no entry → 404");
            assert.equal(result.content, null);
        } finally { await rm(outside, { recursive: true, force: true }); }
    });
});

test("{§packet} File.read: headless workspace (no entries) → 404", async () => {
    await withHeadlessWorkspace(async (ctx) => {
        // Entry-backed read: a headless workspace materializes no file entries, so
        // any file read finds nothing → 404 (uniform with stored entries; the old
        // project_root precondition lived on the deleted disk-read path).
        const result = await readFileScheme(readStmt(filePath("hello.txt")), ctx);
        assert.equal(result.status, 404);
    });
});

test("{§packet} File.read: null path → 400", async () => {
    await withWorkspaceRoot(async (_root, ctx) => {
        const result = await readFileScheme(readStmt(null), ctx);
        assert.equal(result.status, 400);
    });
});

test("{§packet} File.read: lineMarker <N> selects line N as raw content with startLine=N", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        await writeFile(join(root, "f.txt"), "alpha\nbeta\ngamma\n");
        await addMember(ctx, "f.txt");
        const r = await readFileScheme(readStmt(filePath("f.txt"), { lineMarker: { marks: [2] } }), ctx);
        assert.equal(r.status, 200);
        assert.equal(r.content, "beta");
        assert.equal((r as { startLine?: number }).startLine, 2);
    });
});

test("{§packet} File.read: lineMarker <N,M> selects inclusive range as raw content with startLine=N", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        await writeFile(join(root, "f.txt"), "a\nb\nc\nd\n");
        await addMember(ctx, "f.txt");
        const r = await readFileScheme(readStmt(filePath("f.txt"), { lineMarker: { marks: [2, 3] } }), ctx);
        assert.equal(r.status, 200);
        assert.equal(r.content, "b\nc");
        assert.equal((r as { startLine?: number }).startLine, 2);
    });
});

test("{§packet} File.read: lineMarker out of range returns 416", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        await writeFile(join(root, "f.txt"), "one\ntwo\n");
        await addMember(ctx, "f.txt");
        const r = await readFileScheme(readStmt(filePath("f.txt"), { lineMarker: { marks: [99] } }), ctx);
        assert.equal(r.status, 416);
        assert.deepEqual(r.problem?.range, {
            unit: "line",
            total: 2,
            requested: [99, 99],
        });
        assert.equal(r.content, null);
    });
});

test("{§op-shapes} File.read: an invalid exact region remains a composed 416 result", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        await writeFile(join(root, "f.txt"), "one\ntwo\n");
        await addMember(ctx, "f.txt");
        const r = await readFileScheme(readStmt(filePath("f.txt"), {
            lineMarker: { marks: [2, 1, 2, -2] },
        }), ctx);
        assert.equal(r.status, 416);
        assert.deepEqual(r.problem?.requestedCoordinates, [2, 1, 2, -2]);
        assert.equal(Object.hasOwn(r, "range"), false);
        assert.equal(r.content, null);
        // {§op-shapes} -1 as a column is the end of its line, not an invalid region.
        const toEnd = await readFileScheme(readStmt(filePath("f.txt"), { lineMarker: { marks: [2, 1, 2, -1] } }), ctx);
        assert.equal(toEnd.status, 200);
        assert.equal(toEnd.content, "two");
    });
});

test("{§packet} File.find: an exact matcher returns flat match locations", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        await writeFile(join(root, "f.txt"), "foo\nbar foo");
        await addMember(ctx, "f.txt");
        const r = await new File().find(
            findStmt(filePath("f.txt"), { dialect: "regex", raw: "/foo/g", pattern: "foo", flags: "g" }),
            ctx,
        );
        assert.equal(r.status, 200);
        assert.equal(r.mimetype, "application/json");
        assert.ok(r.results.length > 0);
        assert.equal(r.matchingPathCount, 1);
    });
});

test("{§packet} File.find: a binary member does not poison a body search across readable members", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        await writeFile(join(root, "readme.md"), "the needle is here\n");
        await addMember(ctx, "readme.md");
        await EntryCrud.writeEntry(
            { authority: "", pathname: "blob.bin" },
            { channels: { body: { content: "", mimetype: "application/octet-stream" } } },
            ctx,
            "file",
        );

        const result = await new File().find(parseFind("````FIND (**) /needle/````"), ctx);
        assert.equal(result.status, 200);
        assert.deepEqual(resourcePaths(result), ["readme.md"]);
    });
});

test("{§matcher-dispatch} File.find: an invalid matcher preserves the matcher Problem", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        await writeFile(join(root, "f.txt"), "alpha\nbeta\n");
        await addMember(ctx, "f.txt");
        const r = await new File().find(
            findStmt(filePath("f.txt"), { dialect: "regex", raw: "/[/", pattern: "[", flags: "" }),
            ctx,
        );
        assert.equal(r.status, 400);
        assert.equal(r.problem?.type, "https://problems.plurnk.xyz/schemes/matcher/invalid-expression");
        assert.equal(r.problem?.stage, "matcher");
        assert.equal(r.problem?.dialect, "regex");
        assert.equal(r.problem?.recovery, "Revise the matcher expression."); // {§slicer-text-algebra}
        assert.equal(r.problem?.detail, "The regex matcher expression is invalid."); // {§slicer-text-algebra}
        assert.match(String(r.problem?.diagnostic), /Invalid regular expression|unterminated character class/i);
        assert.equal(r.problem?.retryable, false);
        assert.equal(r.content, null);
    });
});

test("{§slicer-text-algebra} File.find: an invalid matcher exposes stable cause and recovery facts", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        await writeFile(join(root, "f.json"), "{\"answer\":42}\n");
        await addMember(ctx, "f.json");
        const r = await new File().find(
            findStmt(filePath("f.json"), { dialect: "jsonpath", raw: "$.[" }),
            ctx,
        );
        assert.equal(r.status, 400);
        assert.equal(r.problem?.stage, "matcher");
        assert.equal(r.problem?.dialect, "jsonpath");
        assert.equal(r.problem?.detail, "The jsonpath matcher expression is invalid."); // {§slicer-text-algebra}
        assert.ok(typeof r.problem?.diagnostic === "string");
        assert.equal(r.problem?.recovery, "Revise the matcher expression."); // {§slicer-text-algebra}
        assert.equal(r.problem?.retryable, false);
        assert.equal("expression" in (r.problem ?? {}), false);
    });
});

test("{§packet} File.find: matcher evaluates the full resource before <L> pages locations", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        await writeFile(join(root, "f.txt"), "alpha\nprojected\nfoo later\n");
        await addMember(ctx, "f.txt");
        const r = await new File().find(
            findStmt(filePath("f.txt"), { dialect: "regex", raw: "/foo/g", pattern: "foo", flags: "g" }),
            ctx,
        );
        assert.equal(r.status, 200);
        assert.ok(r.results.length > 0);
        assert.equal(r.range?.unit, "matchLocation");
    });
});

test("{§packet} File.find: a zero-match selector returns 204", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        await writeFile(join(root, "f.txt"), "alpha\nbeta\n");
        await addMember(ctx, "f.txt");
        const r = await new File().find(
            findStmt(filePath("f.txt"), { dialect: "regex", raw: "/EVALUATOR_FUNCTIONS/", pattern: "EVALUATOR_FUNCTIONS", flags: "" }),
            ctx,
        );
        assert.equal(r.status, 204);
        assert.equal(r.problem, undefined);
    });
});
test("{§packet} File.read: long content round-trips", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        const big = "lorem ipsum dolor sit amet ".repeat(1000);
        await writeFile(join(root, "big.txt"), big);
        await addMember(ctx, "big.txt");
        const result = await readFileScheme(readStmt(filePath("big.txt")), ctx);
        assert.equal(result.status, 200);
        assert.equal(result.content, big.slice(0, Number(process.env.PLURNK_SERVICE_PREVIEW_CHARS)), "a markerless READ is the first page: the character bound cuts the single line ({§packet})");
        const complete = await readFileScheme({ ...readStmt(filePath("big.txt")), lineMarker: { marks: [1, -1] } }, ctx);
        assert.equal(complete.status, 200);
        assert.equal(complete.content, big, "the explicitly requested full content round-trips unchanged");
    });
});

test("{§fs-namespace} File.read: an absolute spelling resolves the existing member", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        await writeFile(join(root, "abs.txt"), "abs content");
        const absolutePath = resolve(root, "abs.txt");
        await addMember(ctx, "abs.txt");
        const result = await readFileScheme(readStmt(filePath(absolutePath)), ctx);
        assert.equal(result.status, 200);
        assert.equal(result.content, "abs content");
    });
});

test("{§packet} File.read: bare relative path (no leading slash) normalizes to the member key and resolves", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        await writeFile(join(root, "notes.md"), "Codename: Bluejay\n");
        await addMember(ctx, "notes.md");
        // The member and the authored path are both project-relative.
        // it copies from the catalog. READ must resolve it the way WRITE does.
        const result = await readFileScheme(parseRead("````READ (notes.md)````"), ctx);
        assert.equal(result.status, 200, "bare relative READ resolves to the notes.md member");
        assert.equal(result.content, "Codename: Bluejay\n");
    });
});

test("{§packet} File.read: a markerless exact READ is the first page, which holds all 20 lines; an explicit <1,-1> is the whole", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        const content = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
        await writeFile(join(root, "bounded.txt"), content);
        await addMember(ctx, "bounded.txt");

        const whole = await readFileScheme(parseRead("````READ (bounded.txt)````"), ctx);
        assert.equal(whole.status, 200);
        assert.equal(whole.content, content);
        assert.equal(whole.range?.total, 20);
        assert.deepEqual(whole.range?.requested, [1, PAGE], "no scope means the first page");
        assert.deepEqual(whole.range?.returned, [1, 20]);

        const all = await readFileScheme(parseRead("````READ (bounded.txt) <1,-1>````"), ctx);
        assert.equal(all.status, 200);
        assert.equal(all.content, content);
        assert.deepEqual(all.range?.returned, [1, 20]);
    });
});

test("{§packet} File.read: bare nested relative path resolves to its member key too", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        await mkdir(join(root, "src"));
        await writeFile(join(root, "src", "app.js"), "// TODO: rename\n");
        await addMember(ctx, "src/app.js");
        const result = await readFileScheme(parseRead("````READ (src/app.js)````"), ctx);
        assert.equal(result.status, 200, "bare nested relative READ resolves");
        assert.equal(result.content, "// TODO: rename\n");
    });
});

test("{§file-snapshot-revision} File.read: absolute path OUTSIDE workspace → 404 (never a member)", async () => {
    await withWorkspaceRoot(async (_root, ctx) => {
        const outside = await mkdtemp(join(tmpdir(), "plurnk-outside-"));
        try {
            const outsideFile = join(outside, "leak.txt");
            await writeFile(outsideFile, "should not be readable");
            const result = await readFileScheme(readStmt(filePath(outsideFile)), ctx);
            // An outside-root path can never be materialized → no entry → 404.
            assert.equal(result.status, 404);
            assert.equal(result.content, null);
        } finally { await rm(outside, { recursive: true, force: true }); }
    });
});

// {§file-snapshot-revision} — rematerialization refreshes both content and extent.
test("{§file-snapshot-revision}: a grown file exposes newly valid lines and its current extent", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        await writeFile(join(root, "grow.txt"), "l1\nl2\nl3\n");
        await addMember(ctx, "grow.txt");
        // A read at line 6 is out of range NOW (3 lines) — the pre-growth 416.
        const before = await readFileScheme(readStmt(filePath("grow.txt"), { lineMarker: { marks: [6] } }), ctx);
        assert.equal(before.status, 416, "line 6 is out of range on the 3-line file");

        // Grow the file to 8 lines and re-materialize.
        await writeFile(join(root, "grow.txt"), "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n");
        await addMember(ctx, "grow.txt");

        // The same read now succeeds against the refreshed snapshot.
        const after = await readFileScheme(readStmt(filePath("grow.txt"), { lineMarker: { marks: [6] } }), ctx);
        assert.equal(after.status, 200, "line 6 reads after the growth — the entry's length tracks disk, not a stale duplicate row");
        assert.equal(after.content, "l6");

        // An over-EOF read names the refreshed line count per {§fs-namespace}.
        // A trailing newline is a terminator, not a ninth addressable line; the
        // advertised extent and the slicer's actual address space are identical.
        const over = await readFileScheme(readStmt(filePath("grow.txt"), { lineMarker: { marks: [99] } }), ctx);
        assert.equal(over.status, 416);
        const range = over.problem?.range as { total?: number };
        assert.equal(range.total, 8, "the range fact carries the refreshed line count");
    });
});

// {§op-shapes} — the channel a receipt advertises is addressable in the bare spelling.
test("{§packet} READ of a bare path with #readable reads the readable channel, not a file named users.html#readable", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        await mkdir(join(root, "data"), { recursive: true });
        await writeFile(join(root, "data/users.html"), "<html>\n  <body>\n    <h1>Team Roster</h1>\n    <p>Alice</p>\n  </body>\n</html>\n");
        await addMember(ctx, "data/users.html");
        const body = await readFileScheme(readStmt({ kind: "local", raw: "data/users.html" }), ctx);
        assert.equal(body.status, 200, JSON.stringify(body));
        const readable = await readFileScheme(readStmt({ kind: "local", raw: "data/users.html", fragment: "readable" }, { lineMarker: { marks: [1, -1] } }), ctx);
        assert.equal(readable.status, 200, JSON.stringify(readable));
        assert.equal(readable.channel, "readable");
        assert.match(String(readable.content), /Team Roster/);
        assert.doesNotMatch(String(readable.content), /<h1>/, "the readable channel is the projection, not the source");
    });
});
});

describe("file-directory-target", () => {
const turnRows = async (program: string | ((root: string) => string)) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-dir-target-"));
    const db = await openMigrated();
    try {
        await mkdir(join(root, "changelog"));
        await writeFile(join(root, "changelog", "7122.bugfix.rst"), "Fixed the thing.\n");
        await mkdir(join(root, "tests", "forms_tests"), { recursive: true });
        await writeFile(join(root, "tests", "forms_tests", "models.py"), "class A: pass\n");
        await mkdir(join(root, "packages", "chord", "docs"), { recursive: true });
        await writeFile(join(root, "packages", "chord", "README.md"), "# Chord\nPackage documentation.\n");
        await writeFile(join(root, "packages", "chord", "docs", "api.md"), "# Chord API\nAPI documentation.\n");
        await mkdir(join(root, "packages", "chord-extra"), { recursive: true });
        await writeFile(join(root, "packages", "chord-extra", "README.md"), "# Other package\n");
        await mkdir(join(root, "empty"));
        await mkdir(join(root, "excluded"));
        await writeFile(join(root, ".gitignore"), "packages/chord/hidden.md\nexcluded/\n");
        await writeFile(join(root, "packages", "chord", "hidden.md"), "Not a member.\n");
        await writeFile(join(root, "excluded", "hidden.md"), "Not a member.\n");
        const env = hermeticGitEnv();
        const git = (...args: string[]) => promisify(execFile)("git", args, { cwd: root, env });
        await git("init", "-q");
        await git("add", "-A");
        await git("-c", "user.email=fixture@plurnk.invalid", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "--no-verify", "-q", "-m", "seed");
        const workspaceId = await insertWorkspace(db, `dir-target-${crypto.randomUUID()}`);
        await rootWorkspace(db, workspaceId, root);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "Look around.");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100_000, responses: [makeRawMockResponse(typeof program === "string" ? program : program(root))] });
        const turn = await engine.runTurn({ messages: [], provider, workspaceId, sessionId, loopId });
        const rows = await db.test_log_entries_by_turn.all<{ op: string; rx: string; attrs: string }>({ turn_id: turn.turnId });
        return rows.filter((row) => row.op !== "NOTE" && row.op !== "SEND" && !LogEntryProjection.isEmission(row)).map(({ op, rx }) => ({ op, ...JSON.parse(rx) as { status: number; content?: string; problem?: Record<string, unknown> } }));
    } finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
};

// The recorded shapes (#853): `READ (changelog) <1,-1>` (pytest) and `READ (tests/forms_tests/) <0>`
// (django) were answered "exists on disk but is not a member", steering the model to admit a directory.
test("{§fs-namespace} {§diagnostic-observation}: a directory target says it is a directory; a READ or KILL carries the listing", async () => {
    const [read, slashed, listing, member, kill, edit] = await turnRows([
        "````READ (changelog) <1,-1>````",
        "````READ (tests/forms_tests/) <0> <!-- list directory structure -->````",
        "````FIND (changelog/)````",
        "````READ (changelog/7122.bugfix.rst)````",
        "````KILL (changelog)````",
        "````EDIT (changelog)\nx\n````",
        "````WAIT````",
    ].join("\n\n")).then((rows) => rows.filter(({ op }) => op !== "SEND"));
    assert.equal(read?.status, 404);
    assert.deepEqual([read?.problem?.type, read?.problem?.detail, read?.problem?.recovery], [
        "https://problems.plurnk.xyz/scheme/file/path-is-directory",
        "'changelog' is a directory, not a file; READ reads one file.",
        "`FIND (changelog/)` lists its files.",
    ]);
    assert.equal(slashed?.problem?.detail, "'tests/forms_tests' is a directory, not a file; READ reads one file."); // {§operation-results}
    assert.equal(slashed?.problem?.recovery, "`FIND (tests/forms_tests/)` lists its files."); // {§operation-results}
    assert.equal(listing?.status, 200, "the named listing form works");
    assert.match(String(listing?.content), /changelog\/7122\.bugfix\.rst/u);
    assert.equal(member?.status, 200, "and the listed path reads");
    assert.deepEqual([kill?.status, kill?.problem?.detail, kill?.problem?.recovery], [
        404,
        "'changelog' is a directory, not a file; KILL removes one file.",
        "`FIND (changelog/)` lists its files.",
    ]);
    assert.deepEqual([edit?.status, edit?.problem?.detail, edit?.problem?.recovery], [
        403,
        "'changelog' is a directory, not a file; EDIT writes one file.",
        undefined,
    ]);
});

const foundPaths = (row: { content?: string }): string[] => {
    const groups = JSON.parse(row.content ?? "null") as { path: string }[][];
    assert.ok(Array.isArray(groups), "FIND returns resource channel groups");
    return groups.map(([first]) => first.path).toSorted();
};

test("{§fs-namespace}: parsed FIND recognizes a directory with or without its trailing slash", async () => {
    const targets: string[] = [];
    const rows = await turnRows((root) => {
        targets.push("packages/chord", "packages/chord/", `${root}/packages/chord`, "./packages/chord",
            "packages/other/../chord", `file://${root}/packages/chord`);
        return [
            ...targets.map((target) => `\`\`\`FIND (${target})\n\`\`\``),
            "```READ (packages/chord/README.md)\n```",
        ].join("\n\n");
    });
    assert.equal(rows.length, targets.length + 1);
    for (const [index, target] of targets.entries()) {
        const row = rows[index];
        assert.equal(row.status, 200, `FIND (${target}) lists its directory`);
        assert.deepEqual(foundPaths(row), ["packages/chord/README.md", "packages/chord/docs/api.md"],
            "only member descendants appear, excluding hidden files and prefix siblings");
    }
    assert.equal(rows.at(-1)?.status, 200, "the same turn can READ a file in the listed directory");
    assert.equal(rows.at(-1)?.content, "# Chord\nPackage documentation.\n");
});

test("{§fs-namespace}: directory resolution retains FIND matching and pagination", async () => {
    const rows = await turnRows([
        "```FIND (packages/chord) /API/\n```",
        "```FIND (packages/chord/) /API/\n```",
        "```FIND (packages/chord) <1>\n```",
        "```FIND (packages/chord/) <1>\n```",
        "```FIND (packages/chord) /absent/\n```",
        "```FIND (packages/chord/) /absent/\n```",
    ].join("\n\n"));
    assert.equal(rows.length, 6);
    assert.equal(rows[0]?.status, 200);
    assert.deepEqual(foundPaths(rows[0]), ["packages/chord/docs/api.md"]);
    assert.deepEqual(rows[0], rows[1], "matching selects resources identically for either spelling");
    assert.equal(rows[2]?.status, 200);
    assert.deepEqual(foundPaths(rows[2]), ["packages/chord/README.md"]);
    assert.deepEqual(rows[2], rows[3], "pagination selects resources identically for either spelling");
    assert.equal(rows[4]?.status, 204);
    assert.deepEqual(rows[4], rows[5], "a nonmatching pattern is an empty result, not a missing directory");
});

test("{§fs-namespace}: empty and non-member-only directories are successful empty surveys", async () => {
    const rows = await turnRows(["empty", "empty/", "excluded", "excluded/"].map(
        (target) => `\`\`\`FIND (${target})\n\`\`\``,
    ).join("\n\n"));
    assert.equal(rows.length, 4);
    for (const row of rows) {
        assert.equal(row.status, 200);
        assert.deepEqual(foundPaths(row), []);
    }
});

test("{§fs-namespace}: exact files and missing targets retain their existing semantics", async () => {
    const rows = await turnRows([
        "```FIND (packages/chord/README.md)\n```",
        "```FIND (packages/chor)\n```",
        "```FIND (packages/missing)\n```",
        "```FIND (packages/missing/)\n```",
        "```FIND (packages/chord*)\n```",
        "```FIND (packages/chord/README.md/child)\n```",
    ].join("\n\n"));
    assert.equal(rows.length, 6);
    assert.equal(rows[0]?.status, 200);
    assert.deepEqual(foundPaths(rows[0]), ["packages/chord/README.md"]);
    for (const [index, target] of [[1, "packages/chor"], [2, "packages/missing"], [5, "packages/chord/README.md/child"]] as const) {
        assert.equal(rows[index]?.status, 404);
        assert.equal(rows[index]?.problem?.type, "https://problems.plurnk.xyz/scheme/file/entry-not-found");
        assert.equal(rows[index]?.problem?.detail, `No member of this workspace is at '${target}'.`);
    }
    assert.equal(rows[3]?.status, 200, "an explicitly authored folder survey may be empty");
    assert.deepEqual(foundPaths(rows[3]), []);
    assert.equal(rows[4]?.status, 200, "a glob is not reinterpreted as a literal directory");
    assert.deepEqual(foundPaths(rows[4]), ["packages/chord-extra/**", "packages/chord/**"]);
});
});

