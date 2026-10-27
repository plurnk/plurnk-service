import test, { describe, type TestContext } from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import File from "../../src/schemes/File.ts";
import GitMembership from "../../src/core/git-membership.ts";
import MembershipMaterialization from "../../src/core/MembershipMaterialization.ts";
import EntryCrud from "../../src/schemes/_entry-crud.ts";
import LogEntryProjection from "../../src/core/LogEntryProjection.ts";
import Namespace from "../../src/core/namespace.ts";
import EvidenceReader from "../../src/evidence/EvidenceReader.ts";
import SearchIndex from "../../src/schemes/_search-index.ts";
import ResourceState from "./resource-state.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile, realpath, appendFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { basename, join, resolve, relative, dirname } from "node:path";
import { type LineMarker, isExecutionOp, type FindStatement, type MatcherBody, type ParsedPath, type ReadStatement, Validator, type Notice } from "@plurnk/plurnk-contracts";
import { type ResolvedEditStatement } from "@plurnk/plurnk-schemes";
import { hermeticGitEnv } from "../../src/core/git-env.ts";
import { DEFAULT_MIMETYPES, makeSchemeCtx, readThroughScheme } from "./_scheme.ts";
import { insertLoop, insertOperationTurn, insertTurn, insertSession, insertWorkspace, openMigrated, rootWorkspace, seedEntryWithChannel, seedEnvelope } from "./_db.ts";
import { serverProposals, TEST_OWNER } from "./_approval.ts";
import { Mock } from "@plurnk/plurnk-providers";
import { rpcCall, connect, withDaemon, runLoopToTerminal, subscribeNotifications } from "./_rpc.ts";
import { makeMockResponse, fixtureExecutors, makeRawMockResponse, parseDsl, userText } from "./_mock.ts";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { type Db } from "../../src/core/Db.ts";
import { type PlurnkSchemeContext } from "../../src/core/scheme-types.ts";
import { MimetypeBinary } from "../../src/content/index.ts";
import { resourcePaths } from "./_find.ts";
import { pathToFileURL } from "node:url";
import { renderTarget, FILE_MISS_RECOVERY } from "../../src/core/plurnk-uri.ts";
import { testArtifactDirectory } from "../../../scripts/lib/test-artifacts.ts";
import { testExecutors, executionAddress, quiesceExecs } from "./_execs.ts";

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
    await t.test("active Git ignore requires an explicit pick", async () => {
        await withWorkspace(async ({ root, file, ctx }) => {
            await execFileP("git", ["init", "-q"], { cwd: root, env: hermeticGitEnv() });
            await writeFile(join(root, ".gitignore"), "ignored.md\n");
            const result = await file.edit(edit("ignored.md", "secret\n"), ctx);
            assert.equal(result.status, 403);
            await assert.rejects(stat(join(root, "ignored.md")));
        });
    });

    await t.test("an exclusion refuses creation", async () => {
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

    await t.test("a workspace cannot widen root to namespace", async () => {
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
    await t.test("removing the exclusion restores the created member", async () => {
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

    await t.test("a later Git-ignore rule is likewise reversible", async () => {
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
const PAGE = Number(process.env.PLURNK_SERVICE_PREVIEW_LINES); // {§markerless-first-page} — the first page a markerless retrieval is

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
    const mimetype = MimetypeBinary.normalizeAutoTextMimetype(await ctx.mimetypes.detect({ path: canonical }));
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

test("{§markerless-first-page} File.read: read existing file inside workspace → 200 + content + text/markdown", async () => {
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

test("{§markerless-first-page} File.read: nested path inside workspace works", async () => {
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

test("{§markerless-first-page} File.read: missing file → 404", async () => {
    await withWorkspaceRoot(async (_root, ctx) => {
        const result = await readFileScheme(readStmt(filePath("missing.txt")), ctx);
        assert.equal(result.status, 404);
        assert.equal(result.content, null);
    });
});

test("{§markerless-first-page} File.read: workspace escape via .. → 403 or 404", async () => {
    await withWorkspaceRoot(async (_root, ctx) => {
        const outside = await mkdtemp(join(tmpdir(), "plurnk-outside-"));
        try {
            await writeFile(join(outside, "secret.txt"), "shouldnt-see");
            const result = await readFileScheme(readStmt(filePath(`../${outside.split("/").pop()}/secret.txt`)), ctx);
            assert.ok(result.status === 403 || result.status === 404, `expected 403 or 404, got ${result.status}`);
        } finally { await rm(outside, { recursive: true, force: true }); }
    });
});

test("{§markerless-first-page} File.read: symlink pointing outside workspace → 404 (never a member)", async () => {
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

test("{§markerless-first-page} File.read: headless workspace (no entries) → 404", async () => {
    await withHeadlessWorkspace(async (ctx) => {
        // Entry-backed read: a headless workspace materializes no file entries, so
        // any file read finds nothing → 404 (uniform with stored entries; the old
        // project_root precondition lived on the deleted disk-read path).
        const result = await readFileScheme(readStmt(filePath("hello.txt")), ctx);
        assert.equal(result.status, 404);
    });
});

test("{§markerless-first-page} File.read: null path → 400", async () => {
    await withWorkspaceRoot(async (_root, ctx) => {
        const result = await readFileScheme(readStmt(null), ctx);
        assert.equal(result.status, 400);
    });
});

test("{§markerless-first-page} File.read: lineMarker <N> selects line N as raw content with startLine=N", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        await writeFile(join(root, "f.txt"), "alpha\nbeta\ngamma\n");
        await addMember(ctx, "f.txt");
        const r = await readFileScheme(readStmt(filePath("f.txt"), { lineMarker: { marks: [2] } }), ctx);
        assert.equal(r.status, 200);
        assert.equal(r.content, "beta");
        assert.equal((r as { startLine?: number }).startLine, 2);
    });
});

test("{§markerless-first-page} File.read: lineMarker <N,M> selects inclusive range as raw content with startLine=N", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        await writeFile(join(root, "f.txt"), "a\nb\nc\nd\n");
        await addMember(ctx, "f.txt");
        const r = await readFileScheme(readStmt(filePath("f.txt"), { lineMarker: { marks: [2, 3] } }), ctx);
        assert.equal(r.status, 200);
        assert.equal(r.content, "b\nc");
        assert.equal((r as { startLine?: number }).startLine, 2);
    });
});

test("{§markerless-first-page} File.read: lineMarker out of range returns 416", async () => {
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

test("{§text-scope-semantics} File.read: an invalid exact region remains a composed 416 result", async () => {
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
        // {§text-scope-semantics} -1 as a column is the end of its line, not an invalid region.
        const toEnd = await readFileScheme(readStmt(filePath("f.txt"), { lineMarker: { marks: [2, 1, 2, -1] } }), ctx);
        assert.equal(toEnd.status, 200);
        assert.equal(toEnd.content, "two");
    });
});

test("{§markerless-first-page} File.find: an exact matcher returns flat match locations", async () => {
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

test("{§markerless-first-page} File.find: a binary member does not poison a body search across readable members", async () => {
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

test("{§matcher-invalid-expression} File.find: an invalid matcher preserves the matcher Problem", async () => {
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
        assert.equal(r.problem?.recovery, "Revise the matcher expression."); // {§problems-schemes}
        assert.equal(r.problem?.detail, "The regex matcher expression is invalid."); // {§problems-schemes}
        assert.match(String(r.problem?.diagnostic), /Invalid regular expression|unterminated character class/i);
        assert.equal(r.problem?.retryable, false);
        assert.equal(r.content, null);
    });
});

test("{§problems-schemes} File.find: an invalid matcher exposes stable cause and recovery facts", async () => {
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
        assert.equal(r.problem?.detail, "The jsonpath matcher expression is invalid."); // {§problems-schemes}
        assert.ok(typeof r.problem?.diagnostic === "string");
        assert.equal(r.problem?.recovery, "Revise the matcher expression."); // {§problems-schemes}
        assert.equal(r.problem?.retryable, false);
        assert.equal("expression" in (r.problem ?? {}), false);
    });
});

test("{§markerless-first-page} File.find: matcher evaluates the full resource before <L> pages locations", async () => {
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

test("{§markerless-first-page} File.find: a zero-match selector returns 204", async () => {
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
test("{§markerless-first-page} File.read: long content round-trips", async () => {
    await withWorkspaceRoot(async (root, ctx) => {
        const big = "lorem ipsum dolor sit amet ".repeat(1000);
        await writeFile(join(root, "big.txt"), big);
        await addMember(ctx, "big.txt");
        const result = await readFileScheme(readStmt(filePath("big.txt")), ctx);
        assert.equal(result.status, 200);
        assert.equal(result.content, big.slice(0, Number(process.env.PLURNK_SERVICE_PREVIEW_CHARS)), "a markerless READ is the first page: the character bound cuts the single line ({§markerless-first-page})");
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

test("{§markerless-first-page} File.read: bare relative path (no leading slash) normalizes to the member key and resolves", async () => {
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

test("{§markerless-first-page} File.read: a markerless exact READ is the first page, which holds all 20 lines; an explicit <1,-1> is the whole", async () => {
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

test("{§markerless-first-page} File.read: bare nested relative path resolves to its member key too", async () => {
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

// {§local-path-fragment} — the channel a receipt advertises is addressable in the bare spelling.
test("{§markerless-first-page} READ of a bare path with #readable reads the readable channel, not a file named users.html#readable", async () => {
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
    assert.equal(slashed?.problem?.detail, "'tests/forms_tests' is a directory, not a file; READ reads one file."); // {§pinned-wording-core}
    assert.equal(slashed?.problem?.recovery, "`FIND (tests/forms_tests/)` lists its files."); // {§pinned-wording-core}
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

describe("file-path-resolution", () => {
const execFileP = promisify(execFile);

test("{§fs-namespace} file URLs preserve native filename identity through reads and receipt reuse", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "plurnk-file-url-")));
    const names = ["tilde~.txt", "space name.txt", "café.txt", "paren(v1).txt", "literal%20.txt", "literal%28.txt", "hash#name.txt", "separator%2F.txt"];
    try {
        await execFileP("git", ["init", "-q"], { cwd: root, env: hermeticGitEnv() });
        for (const name of names) await writeFile(join(root, name), `Content of ${name}\n`);
        await execFileP("git", ["add", "--", ...names], { cwd: root, env: hermeticGitEnv() });
        const frame = PlurnkParser.frame;
        const provider = new Mock({ contextWindow: 100_000, responses: [
            makeMockResponse(names.map((name) => frame(`READ (${pathToFileURL(join(root, name)).href})`, null)).join("\n\n"), 50),
            makeMockResponse(frame("SEND [200]", "Finished."), 50),
        ] });
        await withDaemon(provider, async (db, daemon, addr) => {
            const client = await connect(addr);
            try {
                const created = await rpcCall(client, 1, "workspace.create", { name: "file-urls", projectRoot: root });
                const { id: workspaceId } = created.result as { id: number };
                const loop = await runLoopToTerminal(client, 2, { prompt: "Read the files." });
                assert.equal(loop.result.status, 200);
                const rows = (await db.engine_render_log.all<{ op: string; origin: string; scheme: string | null; pathname: string | null; status_rx: number; rx: string }>({ session_id: loop.modelSessionId! }))
                    .filter(({ origin, op }) => origin === "model" && op === "READ");
                assert.deepEqual(rows.map(({ pathname, status_rx }) => ({ pathname, status_rx })), names.map((pathname) => ({ pathname, status_rx: 200 })));
                for (const row of rows) {
                    const target = renderTarget(row, root);
                    assert.ok(target);
                    const read = (await daemon.dispatchClientAction({ workspaceId, actor: TEST_OWNER, contextSessionId: loop.modelSessionId!, statements: [parseDsl(frame(`READ (${target})`, null))[0]] }))[0];
                    assert.equal(read.status, 200, `reuse ${target}`);
                    assert.equal(read.content, `Content of ${row.pathname}\n`, `identity of ${target}`);
                }
            } finally { client.close(); }
        });
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("{§fs-namespace} encoded file operands compose across mutations, attachments, catalogs and glob reads", async (t) => {
    serverProposals(t, "accept");
    const root = await realpath(await mkdtemp(join(tmpdir(), "plurnk-file-url-ops-[base]-")));
    const directory = "folder %28 #?[v]\\name";
    const names = ["literal%28.txt", "hash#name.txt", "space name.txt", "wild*.txt", "braces{v}.txt", "slash\\name.txt", ".hidden.txt"];
    const key = (name: string): string => `${directory}/${name}`;
    const uri = (name: string): string => pathToFileURL(join(root, key(name))).href.replaceAll("*", "%2A");
    try {
        await execFileP("git", ["init", "-q"], { cwd: root, env: hermeticGitEnv() });
        await mkdir(join(root, directory));
        for (const name of names) await writeFile(join(root, key(name)), `Original ${name}\n`);
        await execFileP("git", ["add", "--", directory], { cwd: root, env: hermeticGitEnv() });
        const frame = PlurnkParser.frame;
        const glob = `${pathToFileURL(join(root, directory)).href}/*.txt`;
        const provider = new Mock({ contextWindow: 100_000, responses: [
            makeMockResponse(names.map((name) => frame(`FIND (${uri(name)})`, null)).join("\n\n"), 50),
            makeMockResponse(names.map((name) => frame(`EDIT (${uri(name)}) <1,-1>`, `Revised ${name}\n`)).join("\n\n"), 50),
            makeMockResponse(names.map((name) => frame(`COPY (${uri(name)}) (${uri(`copy-${name}`)})`, null)).join("\n\n"), 50),
            makeMockResponse(names.map((name) => frame(`MOVE (${uri(`copy-${name}`)}) (${uri(`moved-${name}`)})`, null)).join("\n\n"), 50),
            makeMockResponse([frame(`FIND (${glob})`, null), frame(`READ (${glob})`, null)].join("\n\n"), 50),
            makeMockResponse([...names.map((name) => frame(`KILL (${uri(`moved-${name}`)})`, null)), frame("FIND (*)", null)].join("\n\n"), 50),
            makeMockResponse(frame(`FIND (${pathToFileURL(join(root, directory)).href}/**)`, null), 50),
            makeMockResponse(frame("SEND [200]", "Finished."), 50),
        ] });
        await withDaemon(provider, async (db, daemon, addr) => {
            const client = await connect(addr);
            try {
                const created = await rpcCall(client, 1, "workspace.create", { name: "file-url-operations", projectRoot: root });
                const { id: workspaceId } = created.result as { id: number };
                const loop = await runLoopToTerminal(client, 2, { prompt: "Exercise the encoded addresses.", openPaths: names.map(uri) });
                assert.equal(loop.result.status, 200);
                const rows = await db.engine_render_log.all<{ op: string; origin: string; scheme: string | null; pathname: string | null; status_rx: number; rx: string }>({ session_id: loop.modelSessionId! });
                const authored = rows.filter(({ origin }) => origin === "model");
                assert.deepEqual(authored.filter(({ status_rx }) => status_rx >= 400), [], "no operation failed through address confusion");
                assert.deepEqual(rows.filter(({ origin, op }) => origin === "_plurnk" && op === "READ").map(({ pathname, status_rx }) => ({ pathname, status_rx })),
                    names.map((name) => ({ pathname: key(name), status_rx: 200 })), "client attachments use the native URI boundary");
                for (const op of ["EDIT", "COPY", "MOVE", "KILL"]) {
                    assert.equal(authored.filter((row) => row.op === op && row.status_rx === 200).length, names.length, op);
                }
                const reads = authored.filter(({ op }) => op === "READ");
                assert.equal(reads.length, names.length * 2 - 1, "the glob reads every visible original and moved file once");
                assert.ok(reads.every(({ status_rx }) => status_rx === 200));
                for (const name of names) {
                    assert.equal(await readFile(join(root, key(name)), "utf8"), `Revised ${name}\n`);
                    await assert.rejects(readFile(join(root, key(`copy-${name}`))), { code: "ENOENT" });
                    await assert.rejects(readFile(join(root, key(`moved-${name}`))), { code: "ENOENT" });
                    const address = renderTarget({ scheme: null, pathname: key(name) }, root)!;
                    const read = (await daemon.dispatchClientAction({ workspaceId, actor: TEST_OWNER, contextSessionId: loop.modelSessionId!, statements: [parseDsl(frame(`READ (${address})`, null))[0]] }))[0];
                    assert.equal(read.status, 200, address);
                    assert.equal(read.content, `Revised ${name}\n`);
                    assert.ok(userText(provider.received[1]).includes(address), "the exact FIND advertised a reusable address");
                    const entry = Validator.assertEntryReadResult(await daemon.readEntry({ workspaceId, sessionId: loop.modelSessionId!, target: address }));
                    assert.equal(entry.entry?.channels.body?.content, `Revised ${name}\n`, "the client entry API resolves the same resource");
                }
                const survey = JSON.parse(authored.find(({ op, pathname }) => op === "FIND" && pathname === "*")!.rx);
                const groups = survey.results as Array<Array<{ path: string; items: number }>>;
                assert.equal(groups.length, 1);
                const folder = groups[0][0];
                assert.equal(folder.path, `${pathToFileURL(join(root, directory)).href}/**`);
                assert.equal(folder.items, names.length);
                const subtree = JSON.parse(authored.find(({ op, pathname }) => op === "FIND" && pathname === `${directory}/**`)!.rx);
                assert.equal(subtree.status, 200);
                assert.equal(subtree.matchingPathCount, names.length, "the grouped selector includes hidden members and preserves literal glob characters");
                assert.ok(userText(provider.received[5]).includes(glob), "the glob receipt retains the authored URI's syntax");
                const keys = await db.test_file_pathnames.all<{ pathname: string }>({ workspace_id: workspaceId });
                assert.deepEqual(keys.map(({ pathname }) => pathname).toSorted(), names.map(key).toSorted(), "no encoded or double-decoded shadow identities");
            } finally { client.close(); }
        });
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("{§fs-namespace} digest addresses retain literal identities and authored selectors", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "plurnk-file-url-evidence-")));
    const root = join(dir, "project");
    const dbPath = join(dir, "evidence.db");
    const names = ["literal%28.txt", "hash#name.txt", "wild*.txt"];
    const frame = PlurnkParser.frame;
    const glob = `${pathToFileURL(root).href}/*.txt`;
    try {
        await mkdir(root);
        const db = await openMigrated(dbPath);
        try {
            const ids = await seedEnvelope(db, "file-url-evidence");
            await db.test_set_workspace_project_root.run({ id: ids.workspaceId, project_root: root });
            for (const name of names) {
                await writeFile(join(root, name), `Content of ${name}\n`);
                await seedEntryWithChannel(db, { workspaceId: ids.workspaceId, scheme: "file", pathname: name, content: `Content of ${name}\n` });
            }
            const engine = new Engine({ db, schemes: new SchemeRegistry() });
            let sequence = 0;
            for (const header of [...names.map((name) => `READ (${renderTarget({ scheme: null, pathname: name }, root)})`), `FIND (${glob})`]) {
                const result = await engine.dispatch({ ...ids, sequence: ++sequence, origin: "model", statement: parseDsl(frame(header, null))[0] });
                assert.equal(result.status, 200, header);
            }
        } finally { await db.close(); }
        const evidence = EvidenceReader.open(dbPath);
        try {
            const rows = evidence.rows().logEntries;
            assert.deepEqual(rows.filter(({ op }) => op === "READ").map(({ pathname, target }) => ({ pathname, target })),
                names.map((pathname) => ({ pathname, target: renderTarget({ scheme: null, pathname }, root) })));
            assert.equal(rows.find(({ op }) => op === "FIND")?.target, glob);
        } finally { evidence[Symbol.dispose](); }
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test("{§fs-namespace} malformed URLs refuse only their operation and preserve durable failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-file-url-refusal-"));
    const invalid = [`file://${root}/bad%2Fname`, `file://${root}/bad%00name`, `file://${root}/bad%xy`, `file://${root}/%FF`, `file://remote${root}/file`];
    try {
        const frame = PlurnkParser.frame;
        const provider = new Mock({ contextWindow: 100_000, responses: [
            makeMockResponse(invalid.map((target) => frame(`READ (${target})`, null)).join("\n\n"), 50),
            makeMockResponse(frame("SEND [200]", "The addresses were refused."), 50),
        ] });
        await withDaemon(provider, async (db, _daemon, addr) => {
            const client = await connect(addr);
            try {
                await rpcCall(client, 1, "workspace.create", { name: "invalid-file-urls", projectRoot: root });
                const loop = await runLoopToTerminal(client, 2, { prompt: "Inspect the URLs." });
                assert.equal(loop.result.status, 200);
                const rows = (await db.engine_render_log.all<{ op: string; origin: string; status_rx: number; rx: string }>({ session_id: loop.modelSessionId! }))
                    .filter(({ op, origin }) => op === "READ" && origin === "model");
                assert.equal(rows.length, invalid.length);
                for (const row of rows) {
                    assert.equal(row.status_rx, 400);
                    assert.match(JSON.parse(row.rx).problem.type, /invalid-file-url$/u);
                }
            } finally { client.close(); }
        });
    } finally { await rm(root, { recursive: true, force: true }); }
});

for (const form of ["absolute", "home", "literal"] as const) test(`{§fs-namespace} {§fs-namespace} ${form} paths compose across operations and client reads`, async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const root = await realpath(await mkdtemp(join(form === "home" ? homedir() : tmpdir(), "plurnk-path-resolution-")));
    const directory = form === "literal" ? "~" : "";
    const key = (name: string): string => join(directory, name);
    const spelling = (name: string): string => form === "home"
        ? `~/${relative(homedir(), join(root, name))}`
        : form === "literal" ? `./~/${name}` : join(root, name);
    const relativeSource = form === "literal" ? "./~/source.txt" : "source.txt";
    try {
        await execFileP("git", ["init", "-q"], { cwd: root, env: hermeticGitEnv() });
        await mkdir(join(root, directory), { recursive: true });
        await writeFile(join(root, key("source.txt")), "original\n");
        await execFileP("git", ["add", key("source.txt")], { cwd: root, env: hermeticGitEnv() });
        const source = join(root, key("source.txt"));
        const copied = join(root, key("copied.txt"));
        const moved = join(root, key("moved.txt"));
        const frame = PlurnkParser.frame;
        const provider = new Mock({ contextWindow: 100_000, responses: [
            makeMockResponse(frame("sh", `printf "%s/${key("source.txt")}\\n" "$PWD"`), 50),
            makeMockResponse(frame(`READ (${spelling("source.txt")})`, null), 50),
            makeMockResponse([
                frame(`EDIT (${spelling("source.txt")}) <1,-1>`, "revised\n"),
                frame(`COPY (${spelling("source.txt")}) (${spelling("copied.txt")})`, null),
                frame(`MOVE (${spelling("copied.txt")}) (${spelling("moved.txt")})`, null),
            ].join("\n\n"), 50),
            makeMockResponse([
                frame(`READ (${pathToFileURL(moved).href})`, null),
                frame(`FIND (${spelling("*.txt")})`, null),
                frame(`READ (${spelling("*.txt")})`, null),
            ].join("\n\n"), 50),
            makeMockResponse(frame(`KILL (${spelling("moved.txt")})`, null), 50),
            makeMockResponse(frame("SEND [200]", "Finished."), 50),
        ] });
        await withDaemon(provider, async (db, daemon, addr) => {
            const client = await connect(addr);
            try {
                const notifications = subscribeNotifications(client, "notice/event");
                const created = await rpcCall(client, 1, "workspace.create", { name: "filesystem-paths", projectRoot: root });
                const { id: workspaceId } = created.result as { id: number };
                const loop = await runLoopToTerminal(client, 2, {
                    prompt: "Exercise the filesystem addresses.", openPaths: [relativeSource, source, spelling("source.txt")],
                });
                assert.equal(loop.result.status, 200);
                const rows = await db.engine_render_log.all<{ op: string; origin: string; pathname: string | null; status_rx: number; rx: string }>({ session_id: loop.modelSessionId! });
                const authored = rows.filter(({ origin }) => origin === "model");
                const attached = rows.filter(({ origin, op, pathname }) => origin === "_plurnk" && op === "READ" && pathname === key("source.txt"));
                assert.deepEqual(attached.map(({ status_rx }) => status_rx), [200, 200, 200], "all client attachment spellings resolve the same member");
                assert.ok(rows.some(({ op, rx }) => op === "READ" && rx.includes(source)), "the shell's absolute path reached its stream observation");
                assert.deepEqual(authored.filter(({ op }) => op === "COPY" || op === "MOVE").map(({ op, status_rx }) => ({ op, status_rx })), [
                    { op: "COPY", status_rx: 200 },
                    { op: "MOVE", status_rx: 200 },
                ]);
                assert.deepEqual(authored.filter(({ status_rx }) => status_rx >= 400), [], "normalization causes no failed operation or strike");
                assert.equal(await readFile(source, "utf8"), "revised\n");
                await assert.rejects(readFile(copied), { code: "ENOENT" });
                await assert.rejects(readFile(moved), { code: "ENOENT" });
                await assert.rejects(readFile(join(root, source.slice(1))), { code: "ENOENT" });

                for (const op of ["sh", "READ", "EDIT", "COPY", "MOVE", "FIND", "KILL"]) {
                    assert.ok(authored.some((row) => row.op === op && row.status_rx === 200), `${op} completed`);
                }
                assert.deepEqual(authored.filter(({ op, pathname }) => op === "READ" && pathname === key("source.txt")).map(({ status_rx }) => status_rx), [200, 200], "exact and glob reads converge on the same key");

                const notices = notifications() as { notice: Notice }[];
                const normalized = notices.map(({ notice }) => notice).filter(({ kind }) => kind === "path_normalized");
                assert.equal(normalized.length, form === "literal" ? 1 : 10, "one notice per authored absolute/home operand, never per bound key or automatic observation");
                assert.ok(normalized.every((notice) => notice.source === "scheme:file" && notice.level === "warn"));
                if (form === "literal") {
                    assert.equal(normalized[0].message, "Path resolved to './~/moved.txt'.");
                    assert.ok(userText(provider.received[2]).includes("./~/source.txt"), "literal keys are rendered as reusable addresses");
                } else {
                    assert.ok(normalized.some(({ message }) => message === "Path resolved to 'source.txt'."));
                    assert.ok(normalized.some(({ message }) => message === "Path resolved to 'copied.txt'."));
                    assert.match(userText(provider.received[2]), /YOU SHOULD address the resolved path\. Path resolved to 'source\.txt'\. \[path_normalized\]/u, "the normalization reaches the next model packet");
                }

                for (const target of [relativeSource, spelling("source.txt"), source, pathToFileURL(source).href]) {
                    const result = (await daemon.dispatchClientAction({ workspaceId, actor: TEST_OWNER, contextSessionId: loop.modelSessionId!, statements: [parseDsl(frame(`READ (${target})`, null))[0]] }))[0];
                    assert.equal(result.status, 200, target);
                    assert.equal(result.content, "revised\n", target);
                }
                const entry = Validator.assertEntryReadResult(await daemon.readEntry({ workspaceId, sessionId: loop.modelSessionId!, target: pathToFileURL(source).href }));
                assert.equal(entry.status, 200);
                assert.equal(entry.entry?.channels.body?.content, "revised\n");
                const keys = await db.test_file_pathnames.all<{ pathname: string }>({ workspace_id: workspaceId });
                assert.deepEqual(keys.map(({ pathname }) => pathname), [key("source.txt")]);
                assert.ok(keys.every(({ pathname }) => Namespace.isCanonical(pathname, root)));
            } finally { client.close(); }
        });
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("{§fs-namespace} {§fs-namespace} normalization notices follow authored operands, producer and filesystem base", async () => {
    const db = await openMigrated();
    try {
        for (const projectRoot of ["/project", homedir(), "/", null]) {
            const ids = await seedEnvelope(db, `normalization-${projectRoot}`);
            if (projectRoot !== null) await db.test_set_workspace_project_root.run({ id: ids.workspaceId, project_root: projectRoot });
            await seedEntryWithChannel(db, { workspaceId: ids.workspaceId, scheme: "file", pathname: "probe.txt", content: "member" });
            await seedEntryWithChannel(db, { workspaceId: ids.workspaceId, scheme: "file", pathname: "~/literal.txt", content: "literal" });
            const notices: Notice[] = [];
            const engine = new Engine({ db, schemes: new SchemeRegistry(), noticeNotify: (_workspaceId, { notice }) => { notices.push(notice); } });
            const absolute = join(projectRoot ?? "/", "probe.txt");
            let sequence = 0;
            for (const [target, origin] of [["probe.txt", "model"], [absolute, "_plurnk"], [absolute, "model"], ["./~/literal.txt", "model"]] as const) {
                const result = await engine.dispatch({
                    ...ids, sequence: ++sequence, origin,
                    statement: parseDsl(PlurnkParser.frame(`READ (${target})`, null))[0],
                });
                assert.equal(result.status, projectRoot === null && target === absolute ? 404 : 200, `${projectRoot}: ${origin} ${target}`);
            }
            assert.deepEqual(notices.filter(({ kind }) => kind === "path_normalized"), projectRoot !== null && projectRoot !== "/" ? [{
                source: "scheme:file", kind: "path_normalized", level: "warn", directive: "YOU SHOULD address the resolved path.", message: "Path resolved to 'probe.txt'.",
            }] : []);
            notices.length = 0;
            for (const origin of ["_plurnk", "model"] as const) {
                const result = await engine.dispatch({
                    ...ids, sequence: ++sequence, origin,
                    statement: parseDsl(PlurnkParser.frame("READ (~/probe.txt)", null))[0],
                });
                assert.equal(result.status, projectRoot === homedir() ? 200 : 404, `${projectRoot}: ${origin} ~/probe.txt`);
            }
            // {§fs-namespace} Inside the root the key; beyond it the absolute path, never a climb.
            const homeKey = projectRoot === null ? null : relative(projectRoot, join(homedir(), "probe.txt"));
            const homeAddress = homeKey !== null && homeKey.startsWith("../") ? join(homedir(), "probe.txt") : homeKey;
            assert.deepEqual(notices.filter(({ kind }) => kind === "path_normalized"), projectRoot !== null && projectRoot !== "/" ? [{
                source: "scheme:file", kind: "path_normalized", level: "warn", directive: "YOU SHOULD address the resolved path.", message: `Path resolved to '${homeAddress}'.`,
            }] : []);
            notices.length = 0;
            // An absolute spelling of a path beyond the root is already its canonical address: no notice.
            const beyond = join(projectRoot === homedir() ? "/" : homedir(), `plurnk-beyond-${crypto.randomUUID()}.md`);
            const miss = await engine.dispatch({ ...ids, sequence: ++sequence, origin: "model", statement: parseDsl(PlurnkParser.frame(`READ (${beyond})`, null))[0] });
            assert.equal(miss.status, 404, `${projectRoot}: ${beyond}`);
            assert.deepEqual(notices.filter(({ kind }) => kind === "path_normalized"), [], `${projectRoot}: an absolute spelling beyond the root earns no notice`);
        }
    } finally { await db.close(); }
});
});

describe("namespace-canon", () => {
// {§fs-namespace} {§fs-namespace} — accepted spellings converge on one
// stored Git-relative key; rendered addresses resolve back to that identity.


















const filePath = (pathname: string): ParsedPath => ({ kind: "local", raw: pathname });
const readStmt = (pathname: string): ReadStatement => ({ metadata: null, op: "READ", aside: null, target: filePath(pathname), lineMarker: null, matcher: null, body: null, position: { line: 1, column: 1 } });
const readFileScheme = (statement: ReadStatement, ctx: ReturnType<typeof makeSchemeCtx>) =>
    readThroughScheme("file", null, statement, ctx);
const fullReplace: LineMarker = { marks: [1, -1] };
const editStmt = (pathname: string, body: string, marker: LineMarker | null = null): ResolvedEditStatement => ({ metadata: null, op: "EDIT", aside: null, target: filePath(pathname), lineMarker: marker, body, matcher: null, position: { line: 1, column: 1 } });

const setup = async (databasePath?: string) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-canon-"));
    const db = await openMigrated(databasePath);
    const workspaceId = await insertWorkspace(db, `canon-${crypto.randomUUID()}`);
    await rootWorkspace(db, workspaceId, root);
    const sessionId = await insertSession(db, workspaceId);
    const ctx = makeSchemeCtx({ db, workspaceId, sessionId, mimetypes: DEFAULT_MIMETYPES });
    return { root, db, workspaceId, ctx };
};

for (const glob of ["**", "~/**"]) test(`{§fs-namespace} literal membership glob ${glob} composes with discovery, FTS and exclusion`, async () => {
    const { root, db, workspaceId, ctx } = await setup();
    try {
        await mkdir(join(root, "~"));
        await writeFile(join(root, "~/a.md"), "alpha\n");
        await writeFile(join(root, "~/b.md"), "beta\n");
        await db.crud_insert_family_workspace_constraint.run({ workspace_id: workspaceId, effect: "include", glob, source: "members" });
        await GitMembership.indexGitMembership(ctx);
        const file = new File();
        const find = (pathname: string): FindStatement => ({ ...readStmt(pathname), op: "FIND", lineMarker: null });
        const catalog = await file.find(find("*"), ctx);
        assert.equal(catalog.status, 200);
        assert.ok(JSON.stringify(catalog.results).includes('"path":"./~/**"'), "folder selectors are reusable literal addresses");
        for (const target of ["./~", "./~/", "./~/**", "**"]) {
            const found = await file.find(find(target), ctx);
            assert.equal(found.status, 200, target);
            assert.deepEqual(resourcePaths(found).toSorted(), ["./~/a.md", "./~/b.md"]);
            for (const path of resourcePaths(found)) {
                const read = await readFileScheme(readStmt(path), ctx);
                assert.equal(read.status, 200, path);
                assert.equal(read.content, path.endsWith("a.md") ? "alpha\n" : "beta\n");
            }
        }
        const directory = await readFileScheme(readStmt("./~"), ctx);
        assert.equal(directory.problem?.type, "https://problems.plurnk.xyz/scheme/file/path-is-directory");
        assert.equal(directory.problem?.target, "./~");
        assert.equal(directory.problem?.recovery, "`FIND (./~/)` lists its files.");
        await SearchIndex.maintain(ctx);
        const searched = await file.find({ ...find("./~/**"), matcher: { dialect: "fts", raw: "~alpha" } }, ctx);
        assert.equal(searched.status, 200);
        assert.deepEqual(resourcePaths(searched), ["./~/a.md"], "the pattern-slot tilde remains FTS");

        await db.crud_insert_family_workspace_constraint.run({ workspace_id: workspaceId, effect: "exclude", glob: "~/b.md", source: "members" });
        await GitMembership.indexGitMembership(ctx);
        assert.deepEqual(resourcePaths(await file.find(find("**"), ctx)), ["./~/a.md"]);
        assert.equal(await readFile(join(root, "~/b.md"), "utf8"), "beta\n", "exclusion changes membership, not disk");
    } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});

for (const key of ["~", "~/note.md"]) test(`{§fs-namespace} retained ${key} identity and pending proposal survive reopening unchanged`, async () => {
    const databasePath = join(await testArtifactDirectory("core"), `home-identity-${crypto.randomUUID()}.db`);
    const { root, db, workspaceId, ctx } = await setup(databasePath);
    try {
        await mkdir(dirname(join(root, key)), { recursive: true });
        await writeFile(join(root, key), "original\n");
        const seeded = await db.test_seed_entry_workspace.get<{ id: number }>({ attributes: "{}", default_channel: "body", output: 0, workspace_id: workspaceId, scheme: "file", authority: "", pathname: key });
        assert.ok(seeded);
        await MembershipMaterialization.materializeMember(key, root, ctx, new Map());
        const file = new File();
        const proposal = await file.edit(editStmt(`./${key}`, "revised\n", fullReplace), ctx);
        assert.equal(proposal.status, 202);
        assert.equal((proposal.attrs as { path: string }).path, key, "proposal storage retains its bound literal key");
        await db.close();
        const reopened = await openMigrated(databasePath);
        try {
            const restored = { ...ctx, db: reopened };
            assert.equal((await file.applyResolution({ attrs: proposal.attrs as never, metadata: null }, restored)).status, 200);
            const read = await readFileScheme(readStmt(`./${key}`), restored);
            assert.equal(read.status, 200);
            assert.equal(read.content, "revised\n");
            const retained = await reopened.crud_get_member_sig.get<{ id: number }>({ workspace_id: workspaceId, scheme: "file", authority: "", pathname: key });
            assert.equal(retained?.id, seeded.id);
            assert.deepEqual(await reopened.test_file_pathnames.all({ workspace_id: workspaceId }), [{ pathname: key }]);
        } finally { await reopened.close(); }
    } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});

test("{§fs-namespace}: every spelling of one member resolves to the same row", async () => {
    const { root, db, workspaceId, ctx } = await setup();
    try {
        await mkdir(join(root, "src"), { recursive: true });
        await writeFile(join(root, "src/main.js"), "the one file\n");
        await EntryCrud.writeEntry({ authority: "", pathname: "src/main.js" }, { channels: { body: { content: "the one file\n", mimetype: "text/markdown" } } }, ctx, "file");

        const rootBase = root; // e.g. /tmp/plurnk-canon-XXXX
        const spellings = ["src/main.js", join(root, "src/main.js"), "./src/main.js", "src/./main.js", "a/../src/main.js", `../${rootBase.split("/").at(-1)}/src/main.js`];
        for (const spelling of spellings) {
            const r = await readFileScheme(readStmt(spelling), ctx);
            assert.equal(r.status, 200, `READ(${spelling}) resolves the member`);
            assert.equal(r.content, "the one file\n", `READ(${spelling}) reads the SAME row`);
        }
        const rows = await db.test_count_entry_rows.get<{ n: number }>({ workspace_id: workspaceId, pathname: "src/main.js" });
        assert.equal(rows?.n, 1, "one identity under every spelling");
        const outside = await readFileScheme(readStmt("/src/main.js"), ctx);
        assert.equal(outside.status, 404, "an absolute miss never falls back to the in-root member");
        assert.equal(outside.problem?.target, "/src/main.js", "{§fs-namespace} beyond the root the address is the absolute path, never a climb");
    } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});

test("{§fs-namespace}: repository paths materialize in the workspace namespace", () => {
    assert.equal(Namespace.fromRepositoryPath("project/src/main.js", "/repo/project", "/repo"), "src/main.js");
    assert.equal(Namespace.fromRepositoryPath("sibling/README.md", "/repo/project", "/repo"), "../sibling/README.md");
    assert.throws(() => Namespace.fromRepositoryPath("../escape", "/repo/project", "/repo"), /escapes its repository/);
});

test("{§fs-namespace}: EDIT through an alias answers canonically without minting a shadow row", async () => {
    const { root, db, workspaceId, ctx } = await setup();
    try {
        await writeFile(join(root, "note.md"), "original\n");
        const seeded = await db.test_seed_entry_workspace.get<{ id: number }>({ attributes: "{}", default_channel: "body", output: 0, workspace_id: workspaceId, scheme: "file", authority: "", pathname: "note.md" });
        assert.ok(seeded);
        await MembershipMaterialization.materializeMember("note.md", root, ctx, new Map());
        const before = await db.test_entries_count_all.get<{ n: number }>({});

        const r = await new File().edit(editStmt(join(root, "note.md"), "revised\n", fullReplace), ctx);
        assert.equal(r.status, 202, "the slashed spelling proposes against the member");
        const attrs = r.attrs as { path: string };
        assert.equal(attrs.path, "note.md", "the engine answers in wire canon — never an echo of the model's spelling");
        assert.match((r as { body?: string }).body ?? "", /^Index: note\.md/, "the diff header speaks canon");

        const after = await db.test_entries_count_all.get<{ n: number }>({});
        assert.equal(after?.n, before?.n, "no shadow row is minted via the alternate spelling");
    } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});

test("{§fs-namespace} the storage fixpoint: every file-class row is its own canon", async () => {
    const { root, db, workspaceId, ctx } = await setup();
    try {
        await writeFile(join(root, "a.md"), "a\n");
        await EntryCrud.writeEntry({ authority: "", pathname: "a.md" }, { channels: { body: { content: "a\n", mimetype: "text/markdown" } } }, ctx, "file");
        const rows = await db.test_file_pathnames.all<{ pathname: string }>({ workspace_id: workspaceId });
        assert.ok(rows.length > 0);
        for (const { pathname } of rows) {
            assert.ok(Namespace.isCanonical(pathname, root), `stored key '${pathname}' is its own canon — the resource-state predicate`);
        }
    } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});

test("{§fs-namespace} the log row: address columns speak canon while tx retains non-sensitive authored spelling", async () => {
    const { root, db, workspaceId, ctx } = await setup();
    try {
        await writeFile(join(root, "readme.md"), "hello\n");
        await EntryCrud.writeEntry({ authority: "", pathname: "readme.md" }, { channels: { body: { content: "hello\n", mimetype: "text/markdown" } } }, ctx, "file");

        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const loopId = await insertLoop(db, ctx.sessionId, 1, "go");
        const turnId = await insertTurn(db, loopId, 1, 102);

        const spelling = `${root}/./readme.md`; // a deliberately ugly legal spelling
        const r = await engine.dispatch({
            statement: readStmt(spelling), workspaceId, sessionId: ctx.sessionId, loopId, turnId, sequence: 1, origin: "model",
        });
        assert.equal(r.status, 200, "the ugly spelling resolves");
        const row = await db.test_last_log_row.get<{ pathname: string | null; tx: string }>({ loop_id: loopId });
        assert.equal(row?.pathname, "readme.md", "the engine-authored pathname COLUMN carries wire canon");
        assert.ok(row?.tx.includes("/./readme.md"), "the durable projection retains non-sensitive authored spelling");
    } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});

test("{§fs-write-surface} {§fs-write-surface} {§fs-write-surface}: canonical root and outside-member writes obey the admission matrix", async () => {
    const { root, db, workspaceId, ctx } = await setup();
    const outside = await mkdtemp(join(homedir(), "plurnk-mount-"));
    try {
        const file = new File();

        // (1) root + empty path, no Git and no pick → the root grants exclusive
        // creation. Accepting the proposal establishes the resulting membership.
        const rootCreate = await file.edit(editStmt("fresh.md", "x\n"), ctx);
        assert.equal(rootCreate.status, 202, "the project root admits an exclusive create without another membership grantor");
        const rootApplied = await file.applyResolution({ attrs: rootCreate.attrs as never, metadata: null }, ctx);
        assert.equal(rootApplied.status, 200);
        const rootMember = await db.test_get_origin.get<{ membership_origin: string | null }>({
            workspace_id: workspaceId,
            pathname: "fresh.md",
        });
        assert.equal(rootMember?.membership_origin, "constraint", "the accepted create remains an addressable picked member");
        const rootRead = await readFileScheme(readStmt("fresh.md"), ctx);
        assert.equal(rootRead.status, 200);
        assert.equal(rootRead.content, "x\n");

        // (1') a member definition remains a valid admission path.
        await db.crud_insert_family_workspace_constraint.run({ workspace_id: workspaceId, effect: "include", glob: "**", source: "members" });
        const granted = await file.edit(editStmt("picked.md", "x\n"), ctx);
        assert.equal(granted.status, 202, "the member definition admits the exclusive create");

        // (3) root + existing NON-member (hidden file) → refused; occupancy is all that leaks.
        await writeFile(join(root, "hidden.md"), "secret\n");
        const hiddenEdit = await file.edit(editStmt("hidden.md", "overwrite\n"), ctx);
        assert.equal(hiddenEdit.status, 403, "an existing non-member is never overwritten — the hidden file stays protected");

        // Outside members: pick-granted rw, Git-only ro. Register both grantor shapes.
        await writeFile(join(outside, "client.md"), "client-granted\n");
        await writeFile(join(outside, "gitted.md"), "git-included\n");
        const mountKeyClient = relative(root, join(outside, "client.md"));
        const mountKeyGit = relative(root, join(outside, "gitted.md"));
        const homePath = (name: string): string => `~/${relative(homedir(), join(outside, name))}`;
        await db.crud_insert_family_workspace_constraint.run({ workspace_id: workspaceId, effect: "include", glob: mountKeyClient, source: "members" });
        await db.crud_register_workspace_member.get({ workspace_id: workspaceId, scheme: "file", authority: "", pathname: mountKeyClient, membership_origin: "constraint" });
        await db.crud_register_workspace_member.get({ workspace_id: workspaceId, scheme: "file", authority: "", pathname: mountKeyGit, membership_origin: "git" });
        await MembershipMaterialization.materializeMember(mountKeyClient, root, ctx, new Map());
        await MembershipMaterialization.materializeMember(mountKeyGit, root, ctx, new Map());
        for (const pathname of [mountKeyClient, join(outside, "client.md"), homePath("client.md")]) {
            const rw = await file.edit(editStmt(pathname, "revised\n", fullReplace), ctx);
            assert.equal(rw.status, 202, "relative and absolute spellings preserve the outside member's write grant");
            assert.equal((rw.attrs as { path: string }).path, mountKeyClient);
        }
        for (const pathname of [mountKeyGit, join(outside, "gitted.md"), homePath("gitted.md")]) {
            const ro = await file.edit(editStmt(pathname, "revised\n"), ctx);
            assert.equal(ro.status, 403, "absolute spelling cannot expand a Git-only outside member's authority");
        }

        // Default scope is root, so an absent outside path is refused.
        for (const pathname of [relative(root, join(outside, "new.md")), join(outside, "new.md"), homePath("new.md")]) {
            const mint = await file.edit(editStmt(pathname, "x\n"), ctx);
            assert.equal(mint.status, 403, "root scope cannot mint an outside member");
        }
    } finally { await db.close(); await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test("{§fs-namespace}: facts distinguish a wrong address, occupancy, and an empty survey", async () => {
    const { root, db, ctx } = await setup();
    try {
        await writeFile(join(root, "real.md"), "content\n");
        await EntryCrud.writeEntry({ authority: "", pathname: "real.md" }, { channels: { body: { content: "content\n", mimetype: "text/markdown" } } }, ctx, "file");
        const file = new File();

        // ENOENT on a READ miss carries the resolved name in wire canon.
        const miss = await readFileScheme(readStmt(join(root, "no/such.md")), ctx);
        assert.equal(miss.status, 404);
        assert.equal(miss.problem?.detail, "No member of this workspace is at 'no/such.md'.", "the READ miss states its fact — resolved form, wire canon"); // {§problems-file}
        assert.equal(miss.problem?.recovery, "FIND lists paths. EDIT creates files; `plurnk (members)` admits existing files with a `{\"verb\": \"add\", \"files\": [\"<path>\"]}` body."); // {§problems-file}

        // Exact-path FIND distinguishes absence from a successful empty survey.
        const findMissStmt = { op: "FIND", aside: null, lineMarker: null, position: { line: 1, column: 1 },
            target: { kind: "local", raw: "no/such.md" }, matcher: null, body: null } as never;
        const findMiss = await file.find(findMissStmt, ctx);
        assert.equal(findMiss.status, 404, "FIND over an absent exact path cannot certify an empty set");
        assert.equal(findMiss.problem?.detail, "No member of this workspace is at 'no/such.md'."); // {§problems-file}

        // A FOLDER scope with zero matches stays the blessed orienting empty survey.
        const surveyStmt = { op: "FIND", aside: null, lineMarker: null, position: { line: 1, column: 1 },
            target: { kind: "local", raw: "empty-dir/" }, matcher: null, body: null } as never;
        const survey = await file.find(surveyStmt, ctx);
        assert.equal(survey.status, 200, "an empty folder survey is orienting, not an error");

        // Occupancy (EEXIST-class): a hidden non-member at the path — the fact reveals occupancy only.
        await writeFile(join(root, "occupied.md"), "hidden\n");
        const clobber = await file.edit(editStmt("occupied.md", "x\n"), ctx);
        assert.equal(clobber.status, 403);
        assert.equal(clobber.problem?.type, "https://problems.plurnk.xyz/scheme/file/path-occupied-by-nonmember");
        assert.equal(clobber.problem?.detail, "A non-member file already occupies 'occupied.md'."); // {§problems-file}
        assert.equal(clobber.problem?.path, "occupied.md");
        // {§fs-namespace} — a READ of that same non-member names the door, not absence.
        const peek = await readFileScheme(readStmt("occupied.md"), ctx);
        assert.equal(peek.status, 404);
        assert.equal(peek.problem?.type, "https://problems.plurnk.xyz/scheme/file/entry-not-member");
        assert.equal(peek.problem?.detail, "'occupied.md' exists on disk but is not a member of this workspace."); // {§pinned-wording-core}
        assert.equal(peek.problem?.recovery, "Admit it with `plurnk (members)` and a `{\"verb\": \"add\", \"files\": [\"<path>\"]}` body."); // {§pinned-wording-core}
        assert.equal(clobber.problem?.recovery, "Choose an unoccupied member path."); // {§problems-file}
        assert.equal(clobber.problem?.retryable, false);
    } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});

test("{§fs-namespace}: directory recognition does not probe outside-root paths", async () => {
    const { root, db, ctx } = await setup();
    const outside = await mkdtemp(join(tmpdir(), "plurnk-outside-directory-"));
    try {
        const target = `../${outside.split("/").at(-1)}`;
        const statement: FindStatement = {
            metadata: null, op: "FIND", aside: null, target: filePath(target),
            lineMarker: null, matcher: null, body: null, position: { line: 1, column: 1 },
        };
        const result = await new File().find(statement, ctx);
        assert.equal(result.status, 404, "an unmounted outside directory is not recognized from disk");
        assert.equal(result.problem?.type, "https://problems.plurnk.xyz/scheme/file/entry-not-found");
        assert.equal(result.problem?.detail, `No member of this workspace is at '${resolve(root, target)}'.`, "{§fs-namespace} named by its absolute address");
    } finally { await db.close(); await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test("{§fs-namespace}: beyond the root a miss is the same sentence whether or not a file is there", async () => {
    const { root, db, ctx } = await setup();
    const present = `plurnk-dark-${crypto.randomUUID()}.md`;
    const absent = `plurnk-dark-${crypto.randomUUID()}.md`;
    try {
        // A real file beside the root, and a name nothing holds. Neither is a member.
        await writeFile(join(root, "..", present), "somebody else's\n");
        const there = await readFileScheme(readStmt(`../${present}`), ctx);
        const notThere = await readFileScheme(readStmt(`../${absent}`), ctx);
        for (const [result, name] of [[there, present], [notThere, absent]] as const) {
            assert.equal(result.status, 404);
            assert.equal(result.problem?.type, "https://problems.plurnk.xyz/scheme/file/entry-not-found");
            const address = resolve(root, "..", name);   // {§fs-namespace} absolute beyond the root
            assert.equal(result.problem?.detail, `No member of this workspace is at '${address}'.`, "about the address's membership: it neither claims absence nor hints at presence");
            assert.equal(result.problem?.recovery, `'${address}' is outside the project root: only a members definition under the operator's namespace scope admits it.`, "the recovery speaks of the address too, true under every members scope (#1005)"); // {§problems-file}
        }
        // The disk beyond the root stays dark: swap the names and the two answers are one answer,
        // apart from where each refused read was recorded.
        const normalize = (result: typeof there, name: string): string => {
            const { instance, ...problem } = result.problem!;
            assert.ok(instance, "each refused read is its own recorded act");
            return JSON.stringify({ ...result, problem }).replaceAll(name, "<name>");
        };
        assert.equal(normalize(there, present), normalize(notThere, absent));
    } finally {
        await rm(join(root, "..", present), { force: true });
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("{§fs-write-surface}: accept records constraint provenance before reporting success", async () => {
    const { root, db, workspaceId, ctx } = await setup();
    try {
        await db.crud_insert_family_workspace_constraint.run({ workspace_id: workspaceId, effect: "include", glob: "**", source: "members" });
        const file = new File();
        const proposal = await file.edit(editStmt("stamped.md", "content\n"), ctx);
        assert.equal(proposal.status, 202);
        const applied = await file.applyResolution({ attrs: proposal.attrs as never, body: undefined, metadata: null }, ctx);
        assert.equal(applied.status, 200);
        const row = await db.test_get_origin.get<{ membership_origin: string | null }>({ workspace_id: workspaceId, pathname: "stamped.md" });
        assert.equal(row?.membership_origin, "constraint", "the accepted create carries its represented grantor, not NULL");
    } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});

test("{§fs-namespace} an in-root file no grantor admits DOES NOT EXIST; a client pick brings it into existence", async () => {
    const { root, db, workspaceId, ctx } = await setup();
    try {
        // A real file, physically in the root — non-git root, no pick: NO grantor admits it.
        await writeFile(join(root, "ungran.md"), "present on disk, absent in the workspace\n");
        const invisible = await readFileScheme(readStmt("ungran.md"), ctx);
        assert.equal(invisible.status, 404, "no grantor → the file does not exist for the model (counterintuitive on purpose — the sandbox's center)");

        // A member definition grants it + the membership pass runs → it exists.
        await db.crud_insert_family_workspace_constraint.run({ workspace_id: workspaceId, effect: "include", glob: "ungran.md", source: "members" });
        await GitMembership.indexGitMembership(ctx);
        const visible = await readFileScheme(readStmt("ungran.md"), ctx);
        assert.equal(visible.status, 200, "the client's explicit grant is what brings it into existence — every visible byte traces to an external grantor");
        assert.match(visible.content ?? "", /present on disk/);
    } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});

test("{§problems-file} {§diagnostic-observation} a file target named like an executor misses like any path, presuming no fence (#902)", async () => {
    const { root, db, ctx } = await setup();
    try {
        const executors = await testExecutors();
        assert.ok(executors.availableRuntimes(ctx.workspaceId).includes("sh"), "the real shell executor is available to the fixture");
        const withExecutors = { ...ctx, executors };
        for (const key of ["sh", "nope", "tools/sh"]) {
            const miss = await readFileScheme(readStmt(key), withExecutors);
            assert.equal(miss.status, 404, key);
            assert.equal(miss.problem?.recovery, "FIND lists paths. EDIT creates files; `plurnk (members)` admits existing files with a `{\"verb\": \"add\", \"files\": [\"<path>\"]}` body.", key);
        }
    } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});
});

describe("refusal-recovery", () => {
// {§problem-details} — a refusal carries the next step its producer knows (#1005).
// {§fs-namespace} {§log-history-projection} {§exec-target-routing} {§unregistered-scheme-recovery} {§find-result-projection} {§exec-lifetime}
















const execFileP = promisify(execFile);
type Problem = { type?: string; detail?: string; recovery?: string; target?: string };
type Row = { status_rx: number; rx: string };

const runtime = async (t: TestContext) => {
    serverProposals(t, "accept");
    const env = { PLURNK_SERVICE_GIT_ALLOWED: process.env.PLURNK_SERVICE_GIT_ALLOWED, PLURNK_SERVICE_GIT_AUTO: process.env.PLURNK_SERVICE_GIT_AUTO };
    process.env.PLURNK_SERVICE_GIT_ALLOWED = "1";
    process.env.PLURNK_SERVICE_GIT_AUTO = "1";
    const root = await mkdtemp(join(tmpdir(), "refusal-recovery-"));
    const git = (args: string[]) => execFileP("git", args, { cwd: root, env: hermeticGitEnv() });
    await git(["init", "-q"]);
    await writeFile(join(root, ".gitignore"), "generated.log\n");
    await writeFile(join(root, "a.md"), "alpha\n");
    await git(["add", ".gitignore", "a.md"]);
    await git(["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-q", "--no-verify", "-m", "seed"]);
    await writeFile(join(root, "generated.log"), "built\n");
    await writeFile(join(root, "loose.md"), "loose\n");
    const db = await openMigrated();
    const ids = await seedEnvelope(db, `refusal-recovery-${crypto.randomUUID()}`);
    await rootWorkspace(db, ids.workspaceId, root);
    const schemes = new SchemeRegistry();
    const executors = await testExecutors();
    schemes.registerRuntimeSchemes(executors);
    const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
    engine.setExecutors(executors);
    t.after(async () => {
        await quiesceExecs(schemes);
        db.close();
        await rm(root, { recursive: true, force: true });
        for (const [key, value] of Object.entries(env)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });
    let sequence = 0;
    const dispatch = async (source: string): Promise<{ status: number; problem: Problem }> => {
        const { items } = PlurnkParser.parseStatements(source, { executors: fixtureExecutors(source) });
        const item = items[0];
        if (item?.kind !== "statement") throw new Error(`test operation did not parse: ${source}`);
        await engine.dispatch({ ...ids, sequence: ++sequence, origin: "model", statement: item.statement });
        const written = await db.log_read_by_coordinate.get<Row>({ session_id: ids.sessionId, loop_seq: 1, turn_seq: 1, sequence });
        assert.ok(written, source);
        return { status: written.status_rx, problem: (JSON.parse(written.rx) as { problem?: Problem }).problem ?? {} };
    };
    return { db, engine, ids, root, dispatch, sequence: () => sequence };
};

test("{§fs-namespace} every file miss names its member key and carries the miss recovery", async (t) => {
    const { dispatch } = await runtime(t);
    for (const source of ["````FIND (missing.py)````", "````KILL (missing.py)````", "````EDIT (missing.py) /alpha/\nomega\n````", "````READ (missing.py)````"]) {
        const { status, problem } = await dispatch(source);
        assert.equal(status, 404, source);
        assert.equal(problem.detail, "No member of this workspace is at 'missing.py'.", `${source}: the key, never a file:// URI`);
        assert.equal(problem.recovery, FILE_MISS_RECOVERY, source);
    }
});

test("{§fs-namespace} {§fs-namespace} a key beyond the root is told it is outside the root, by its absolute address, never offered FIND, EDIT or admission", async (t) => {
    const { dispatch, root } = await runtime(t);
    const address = resolve(root, "../outside/delete_tests.log");
    for (const source of ["````READ (../outside/delete_tests.log)````", "````FIND (../outside/delete_tests.log)````", "````KILL (../outside/delete_tests.log)````", `\`\`\`\`READ (${address})\`\`\`\``]) {
        const { status, problem } = await dispatch(source);
        assert.equal(status, 404, source);
        assert.equal(problem.detail, `No member of this workspace is at '${address}'.`, `${source}: the address's membership, nothing about the disk`);
        assert.equal(problem.target, address, `${source}: beyond the root the address is absolute, never a climb`);
        assert.equal(problem.recovery, `'${address}' is outside the project root: only a members definition under the operator's namespace scope admits it.`, source);
    }
});

test("{§fs-namespace} {§fs-namespace} home, literal and absolute misses retain the resolved identity and membership boundary", async (t) => {
    const { dispatch, root } = await runtime(t);
    const homeKey = relative(root, homedir());
    for (const [spelling, key] of [["~/plurnk-missing.md", `${homeKey}/plurnk-missing.md`], ["~", homeKey], ["~/", homeKey]]) {
        const miss = await dispatch(PlurnkParser.frame(`READ (${spelling})`, null));
        // {§fs-namespace} The home directory lies beyond this root, so its address is absolute.
        const address = key.startsWith("../") ? resolve(root, key) : key;
        assert.equal(miss.status, 404, spelling);
        assert.equal(miss.problem.detail, `No member of this workspace is at '${address}'.`);
        assert.equal(miss.problem.target, address);
        assert.equal(miss.problem.recovery, `'${address}' is outside the project root: only a members definition under the operator's namespace scope admits it.`);
    }
    for (const [spelling, key] of [["./~/missing.md", "~/missing.md"], ["./~", "~"], ["~someone/notes.md", "~someone/notes.md"]]) {
        const miss = await dispatch(PlurnkParser.frame(`READ (${spelling})`, null));
        assert.equal(miss.status, 404, spelling);
        assert.equal(miss.problem.detail, `No member of this workspace is at '${key}'.`);
        assert.equal(miss.problem.target, spelling, "the literal member address can be reused");
        assert.equal(miss.problem.recovery, FILE_MISS_RECOVERY);
    }
    // An absolute path beyond the root is spelled back as itself and carries the outside-root recovery.
    const outsideName = `plurnk-outside-${crypto.randomUUID()}.md`;
    const outsideAddress = resolve(root, "..", outsideName);
    const outside = await dispatch(`\`\`\`\`READ (${join(root, "..", outsideName)})\`\`\`\``);
    assert.equal(outside.status, 404);
    assert.equal(outside.problem.detail, `No member of this workspace is at '${outsideAddress}'.`, "the absolute address, never a climb");
    assert.equal(outside.problem.recovery, `'${outsideAddress}' is outside the project root: only a members definition under the operator's namespace scope admits it.`);
    // An absolute path inside the root is its in-root key and keeps the in-root recovery.
    const inside = await dispatch(`\`\`\`\`READ (${join(root, "missing.py")})\`\`\`\``);
    assert.equal(inside.status, 404);
    assert.equal(inside.problem.detail, "No member of this workspace is at 'missing.py'.");
    assert.equal(inside.problem.recovery, FILE_MISS_RECOVERY, "inside the root the listing, creation and admission doors stand");
});

test("{§fs-namespace} a non-member an exclusion covers or the repository ignores is not offered an admission no model definition can make", async (t) => {
    const { db, ids, root, dispatch } = await runtime(t);
    const ignored = await dispatch("````READ (generated.log)````");
    assert.equal(ignored.problem.detail, "'generated.log' exists on disk but is not a member of this workspace.");
    assert.equal(ignored.problem.recovery, "Git ignores it (`.gitignore` line 1): a client or operator members definition can include it, a model definition cannot.");
    const untracked = await dispatch("````READ (loose.md)````");
    assert.equal(untracked.problem.recovery, "Admit it with `plurnk (members)` and a `{\"verb\": \"add\", \"files\": [\"<path>\"]}` body.", "an untracked file is still admitted");
    await writeFile(join(root, "secret.md"), "hidden\n");
    await db.crud_insert_family_workspace_constraint.run({ workspace_id: ids.workspaceId, effect: "exclude", glob: "secret.md", source: "members" });
    const excluded = await dispatch("````READ (secret.md)````");
    assert.equal(excluded.problem.detail, "'secret.md' exists on disk but is not a member of this workspace.", "an excluded file on disk says so");
    assert.doesNotMatch(excluded.problem.recovery ?? "", /plurnk \(members\)/u, "an exclusion no add lifts is not offered one");
    assert.match(excluded.problem.recovery ?? "", /!secret\.md/u, "the refusal names the exclusion");
});

// {§membership} Each place an ignore rule lives, named by its file and line: the repository's `.gitignore`,
// its `.git/info/exclude`, git's default excludes file under the daemon user's configuration home, and a `core.excludesFile`
// that user configures ({§membership}); a negated pattern re-includes and is no ignore.
test("{§membership} an ignored file's refusal names the rule's file and line, wherever the rule lives", async (t) => {
    const { root, dispatch } = await runtime(t);
    const prior = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
    const homes = await mkdtemp(join(tmpdir(), "ignore-homes-"));
    t.after(async () => {
        for (const [key, value] of Object.entries(prior)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        await rm(homes, { recursive: true, force: true });
    });
    const asHome = async (name: string, files: Record<string, string>): Promise<void> => {
        const home = join(homes, name);
        for (const [path, content] of Object.entries(files)) {
            await mkdir(join(home, path, ".."), { recursive: true });
            await writeFile(join(home, path), content);
        }
        process.env.HOME = home;
        process.env.XDG_CONFIG_HOME = join(home, ".config");
    };
    await appendFile(join(root, ".gitignore"), "*.tmp\n!keep.tmp\n");
    const exclude = join(root, ".git", "info", "exclude");
    const excludeLine = (await readFile(exclude, "utf8").catch(() => "")).split("\n").filter((line, index, lines) => index < lines.length - 1 || line.length > 0).length + 1;
    await mkdir(join(root, ".git", "info"), { recursive: true });
    await appendFile(exclude, "info.md\n");
    for (const name of ["default.md", "configured.md", "info.md", "drop.tmp", "keep.tmp"]) await writeFile(join(root, name), "x\n");
    const named = async (path: string): Promise<string | undefined> => (await dispatch(`\`\`\`\`READ (${path})\`\`\`\``)).problem.recovery;

    await asHome("default", { ".config/git/ignore": "default.md\n" });
    for (const [path, file, line] of [["default.md", "~/.config/git/ignore", 1], ["info.md", ".git/info/exclude", excludeLine], ["drop.tmp", ".gitignore", 2]] as const) {
        assert.match(await named(path) ?? "", new RegExp(`^Git ignores it \\(\`${file.replaceAll(".", "\\.")}\` line ${line}\\)`, "u"), `${path} names ${file} line ${line}`);
    }
    assert.match(await named("keep.tmp") ?? "", /plurnk \(members\)/u, "a re-included path is untracked, not ignored");

    await asHome("configured", { ".gitconfig": "[core]\n\texcludesFile = ~/my-ignore\n", "my-ignore": "configured.md\n" });
    assert.match(await named("configured.md") ?? "", /^Git ignores it \(`~\/my-ignore` line 1\)/u, "the user's configured excludes file is honored and named");
});

test("{§log-history-projection} a log miss beside real rows names them", async (t) => {
    const { dispatch } = await runtime(t);
    await dispatch("````READ (a.md)````");
    await dispatch("````FIND (a.md) /alpha/````");
    const wrongLeaf = await dispatch("````READ (log:///1/1/1/sh)````");
    assert.equal(wrongLeaf.status, 404);
    assert.equal(wrongLeaf.problem.recovery, "The entry at log:///1/1/1 is `log:///1/1/1/READ`.");
    assert.equal((await dispatch("````FIND (log:///1/1/2/READ)````")).problem.recovery, "Turn 1/1's READ rows are `log:///1/1/1/READ`, `log:///1/1/3/READ`; the entry at log:///1/1/2 is `log:///1/1/2/FIND`.", "the leaf asked for first, then what the guessed sequence holds");
    assert.equal((await dispatch("````KILL (log:///1/1/1/sh)````")).problem.recovery, "The entry at log:///1/1/1 is `log:///1/1/1/READ`.", "the curation a 413 demands is told the same");
    // The rtx5070 benchlet's shape (run393): a turn's row asked for at the sequence another row holds.
    assert.equal((await dispatch("````KILL (log:///1/1/1/FIND)````")).problem.recovery, "Turn 1/1's FIND rows are `log:///1/1/2/FIND`, `log:///1/1/4/FIND`; the entry at log:///1/1/1 is `log:///1/1/1/READ`.");
    assert.equal((await dispatch("````READ (log:///1/1/9/FIND)````")).problem.recovery, "Turn 1/1's FIND rows are `log:///1/1/2/FIND`, `log:///1/1/4/FIND`.", "a sequence off names the turn's rows that carry the leaf");
    assert.equal((await dispatch("````READ (log:///1/4/1/READ)````")).problem.recovery, "Turn 1/4 has no entries; loop 1's latest turn is 1/1.");
    assert.equal((await dispatch("````READ (log:///7/1/1/READ)````")).problem.recovery, undefined, "a loop with no rows has nothing to name");
});

test("{§unregistered-scheme-recovery} {§diagnostic-observation} an unregistered scheme names what is registered, whatever its authority", async (t) => {
    const { dispatch } = await runtime(t);
    const executorAuthority = await dispatch("````WORK (tool://sh/run)\nls\n````");
    assert.equal(executorAuthority.status, 501);
    assert.equal(executorAuthority.problem.detail, "Scheme 'tool' is not registered.");
    const listed = await dispatch("````READ (nosuch://x/y)````");
    for (const refused of [executorAuthority, listed]) assert.match(refused.problem.recovery ?? "", /^Registered schemes: .*\bfile\b.*\blog\b.*\.$/u);
});

test("{§find-result-projection} {§diagnostic-observation} a full-text query FTS5 refuses carries FTS5's message and the dialect's form", async (t) => {
    const { engine, ids, dispatch } = await runtime(t);
    assert.equal((await dispatch("````EDIT (workspace:///notes.md)\nif all(flags):\n````")).status, 201);
    await engine.warmWorkspaceDerivations(ids.workspaceId);
    const refused = await dispatch("````FIND (workspace:///notes.md) ~all(````");
    assert.equal(refused.status, 400);
    assert.equal(refused.problem.recovery, "An FTS5 query is barewords, \"quoted phrases\", and AND, OR, NOT and NEAR between them.");
});

test("{§exec-lifetime} {§diagnostic-observation} an execution that outlives its lifetime says so, and nothing more", async (t) => {
    const { db, ids, dispatch, sequence } = await runtime(t);
    assert.equal((await dispatch("````sh [{\"lifetime\": \"1s\"}]\nsleep 5\n````")).status, 200);
    const stream = await executionAddress(db, ids.turnId, sequence());
    let ended: { status: number; problem: Problem } | undefined;
    for (let attempt = 0; attempt < 60 && ended === undefined; attempt++) {
        await new Promise((settle) => setTimeout(settle, 250));
        const read = await dispatch(`\`\`\`\`READ (${stream})\`\`\`\``);
        if (read.status === 504) ended = read;
    }
    assert.ok(ended, "the deadline closes the stream with 504");
    assert.equal(ended.problem.detail, "Execution of 'sh' outlived its 1s lifetime.");
    assert.equal(ended.problem.recovery, undefined);
});

test("{§exec-target-routing} an execution id written under another runtime names the address it holds", async (t) => {
    const { db, ids, dispatch, sequence } = await runtime(t);
    assert.equal((await dispatch("````python3\nprint(1)\n````")).status, 200);
    const stream = await executionAddress(db, ids.turnId, sequence());
    const id = stream.replace(/^python3:\/\/\//u, "");
    const killed = await dispatch(`\`\`\`\`KILL (sh:///${id})\`\`\`\``);
    assert.equal(killed.status, 404);
    assert.equal(killed.problem.detail, `No stream exists at sh:///${id}.`);
    assert.equal(killed.problem.recovery, `The execution at /${id} is \`${stream}\`.`);
});
});

describe("resource-state", () => {
// {§fs-resource-state} Positive and negative integrity witnesses; the soak covers repeated turns.









test("{§fs-resource-state} consistent resource state reports no violations after real lifecycle traffic", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-ws-"));
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ws-clean-${crypto.randomUUID()}`);
        await rootWorkspace(db, workspaceId, root);
        const sessionId = await insertSession(db, workspaceId);
        const ctx = makeSchemeCtx({ db, workspaceId, sessionId, mimetypes: DEFAULT_MIMETYPES });
        await writeFile(join(root, "a.md"), "a\n");
        await EntryCrud.writeEntry({ authority: "", pathname: "a.md" }, { channels: { body: { content: "a\n", mimetype: "text/markdown" } } }, ctx, "file");
        await db.crud_register_workspace_member.get({ workspace_id: workspaceId, scheme: "file", authority: "", pathname: "b.md", membership_origin: "git" });

        const violations = await ResourceState.check(db);
        assert.deepEqual(violations, [], "consistent resources produce no violations");
    } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});

test("{§fs-namespace} the detector CATCHES: a non-canon stored key and an alien grantor both self-name", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-ws-bad-"));
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `ws-bad-${crypto.randomUUID()}`);
        await rootWorkspace(db, workspaceId, root);

        // A non-canon key stored raw.
        await db.test_seed_entry_workspace.get({ attributes: "{}", default_channel: "body", output: 0, workspace_id: workspaceId, scheme: "file", authority: "", pathname: "/noncanon.md" });
        // An alien grantor cannot be written: the schema CHECK refuses it.
        await assert.rejects(
            () => db.test_set_origin.run({ workspace_id: workspaceId, pathname: "/noncanon.md", membership_origin: "plurnk-decided" }),
            /CHECK constraint failed/,
            "the closed admission set is enforced at the schema wall",
        );

        const violations = await ResourceState.check(db);
        const laws = violations.map((v) => v.invariant).toSorted();
        assert.ok(laws.includes("{§fs-namespace}"), `the non-canon key is caught: ${JSON.stringify(violations)}`);
    } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});
});
