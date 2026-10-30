import test, { describe, type TestContext } from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import File from "../../src/schemes/File.ts";
import GitMembership from "../../src/core/git-membership.ts";
import fs, { mkdtemp, rm, writeFile, readFile, mkdir, chmod } from "node:fs/promises";
import DbProjectionCaps from "../../src/core/caps/DbProjectionCaps.ts";
import EntryCrud from "../../src/schemes/_entry-crud.ts";
import MembershipMaterialization from "../../src/core/MembershipMaterialization.ts";
import FileSnapshot from "../../src/core/FileSnapshot.ts";
import FilePublication from "../../src/core/FilePublication.ts";
import GitState from "../../src/core/git-state.ts";
import PacketWire from "../../src/core/packet-wire.ts";
import { completeStmt, editStmt, copyStmt, moveStmt, readStmt, localPath, fullReplace } from "./_dsl.ts";
import { hermeticGitEnv, excludesFile } from "../../src/core/git-env.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PlurnkStatement, type ReadStatement, type ParsedPath } from "@plurnk/plurnk-contracts";
import { Mock } from "@plurnk/plurnk-providers";
import { type Db } from "../../src/core/Db.ts";
import { type PlurnkSchemeContext } from "../../src/core/scheme-types.ts";
import { openMigrated, insertWorkspace, insertSession, insertLoop, insertTurn, rootWorkspace } from "./_db.ts";
import { DEFAULT_MIMETYPES, readThroughScheme, makeSchemeCtx, mimetypesFixture } from "./_scheme.ts";
import { logEntries } from "./_packet.ts";
import { ownSession } from "./_approval.ts";
import { clientRead } from "./_client-read.ts";
import { existsSync } from "node:fs";
import { initializeDemoRepository } from "./_git.ts";
import { rpcCall, connect, withDaemon, runLoopToTerminal } from "./_rpc.ts";
import { makeMockResponse } from "./_mock.ts";

describe("contract-workspace", () => {
// {§membership}: workspace identity, file membership, and disk co-location.





















const execFileP = promisify(execFile);
const readFileScheme = (statement: ReadStatement, ctx: PlurnkSchemeContext) =>
    readThroughScheme("file", null, statement, ctx);

const filePath = (pathname: string): ParsedPath => ({ kind: "local", raw: pathname });

const mockResponse = (ops: PlurnkStatement[]) => ({
    assistant: { content: "", ops, reasoning: null },
});

// ───────────────────────────── {§membership} ─────────────────────────────
//
// Git-substrate membership ({§membership}), its overlays, and
// divergence signaling compose through the specimens below.

// Set up a workspace whose project_root is a freshly `git init`'d repo holding
// one COMMITTED, git-tracked file that is NEVER added via
// test_seed_entry_workspace. Per {§membership} D4 it should be a member by virtue of
// `git ls-files`.
const withGitWorkspace = async (
    fn: (root: string, ctx: PlurnkSchemeContext, db: Db, trackedPath: string) => Promise<void>,
): Promise<void> => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-git-"));
    const db = await openMigrated();
    try {
        await execFileP("git", ["init", "-q"], { cwd: root, env: hermeticGitEnv() });
        await execFileP("git", ["config", "user.email", "fixture@plurnk.invalid"], { cwd: root, env: hermeticGitEnv() });
        await execFileP("git", ["config", "user.name", "t"], { cwd: root, env: hermeticGitEnv() });
        const trackedPath = "tracked.md";
        await writeFile(join(root, trackedPath), "# Tracked by git\n\nThis file is a git member.\n");
        await execFileP("git", ["add", trackedPath], { cwd: root, env: hermeticGitEnv() });
        // --no-verify + isolated config: the test repo must not inherit the
        // outer project's commit-msg hooks (commitlint) or signing config —
        // this commit is fixture setup, not a project commit.
        await execFileP("git", [
            "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null",
            "commit", "--no-verify", "-q", "-m", "seed",
        ], { cwd: root, env: hermeticGitEnv() });

        const workspaceId = await insertWorkspace(db, `git-ws-${crypto.randomUUID()}`);
        // Root the workspace via the fixture helper — a direct pointer write plus the
        // same creation-time membership resolve workspace.create({projectRoot})
        // performs (headless is forever: production sets the pointer only at
        // create; a raw UPDATE alone would skip the resolve).
        await rootWorkspace(db, workspaceId, root);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1);
        const turnId = await insertTurn(db, loopId, 1, 102);
        const ctx: PlurnkSchemeContext = {
            db, workspaceId, sessionId, loopId, turnId,
            writer: "model", signal: undefined, mimetypes: DEFAULT_MIMETYPES,
            weigh: (t: string) => Math.ceil(t.length / 4),
        };
        await fn(root, ctx, db, trackedPath);
    } finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
};

test("{§membership}: an untracked file is never an ambient member — tracked or picked only", async () => {
    await withGitWorkspace(async (root, ctx, db, trackedPath) => {
        // On disk, untracked, never `git add`ed, not ignored: the fourth category that must not exist.
        await writeFile(join(root, "draft.md"), "# a loose file\n");
        await writeFile(join(root, ".gitignore"), "secret.env\n");
        await writeFile(join(root, "secret.env"), "TOKEN=xxx\n");

        await GitMembership.indexGitMembership(ctx);
        const member = async (pathname: string) => db.crud_find_workspace_entry.get<{ id: number }>({ workspace_id: ctx.workspaceId, scheme: "file", authority: "", pathname });

        assert.equal(await member("draft.md"), undefined, "untracked-but-not-ignored is not a member: no fourth category");
        assert.equal(await member("secret.env"), undefined, "an ignored file is never a member");
        assert.ok(await member(trackedPath), "the tracked file is the member");

        // A member definition admits it; git add would too. Nothing else does.
        await db.crud_insert_family_workspace_constraint.run({ workspace_id: ctx.workspaceId, effect: "include", glob: "draft.md", source: "members" });
        await GitMembership.indexGitMembership(ctx);
        assert.ok(await member("draft.md"), "a member definition admits the untracked file");
    });
});

test("{§membership} git-tracked file (never client-added) is a workspace member via git ls-files", async () => {
    await withGitWorkspace(async (_root, ctx, db, trackedPath) => {
        // The file is committed in git but NO test_seed_entry_workspace was
        // issued for it. Under {§membership} D4 (git present → ls-files membership),
        // it MUST register as a member of the workspace.
        const member = await db.crud_find_workspace_entry.get<{ id: number }>({
            workspace_id: ctx.workspaceId, scheme: "file", authority: "", pathname: trackedPath,
        });
        assert.notEqual(
            member, undefined,
            "git-tracked file must be a workspace member via `git ls-files` (SPEC {§membership})",
        );

        // And the membership gate in File.read must therefore admit it (200),
        // not 404 it as a non-member. Production materializes members every turn
        // (indexGitMembership at runTurn); do the same before the entry-backed read.
        await GitMembership.indexGitMembership(ctx);
        const result = await readFileScheme(readStmt(filePath(trackedPath)), ctx);
        assert.equal(
            result.status, 200,
            "READ of a git-tracked member must succeed; 404 means git membership was not established",
        );
        assert.equal(result.content, "# Tracked by git\n\nThis file is a git member.\n");
    });
});

test("{§fs-write-surface} EDIT of an existing non-member is refused — no read (leak), no overwrite (wipe)", async () => {
    await withGitWorkspace(async (root, ctx, _db, trackedPath) => {
        // A gitignored/untracked secret on disk: it EXISTS but is never a member
        // (not in `git ls-files`, never client-added), so the model can't see it.
        const SECRET = "API_KEY=sk-do-not-leak\n";
        await writeFile(join(root, ".env"), SECRET);

        // EDIT it (as if blindly creating a config). Forbidden BEFORE any read:
        // 403, no secret anywhere in the result, file untouched on disk.
        const blocked = await new File().edit(editStmt(filePath(".env"), "PWNED=1\n"), ctx);
        assert.equal(blocked.status, 403, "EDIT of an existing non-member must be forbidden");
        assert.ok(!JSON.stringify(blocked).includes("sk-do-not-leak"), "the refused EDIT must not read the non-member's content into its result (no leak)");
        assert.equal(await readFile(join(root, ".env"), "utf8"), SECRET, "the non-member file must not be overwritten (no wiping a file the model can't see)");

        // The gate must not break legitimate edits: a tracked member still
        // proposes (202), and a new path still proposes creation (202 — creation
        // is how the model adds to its manifest).
        await GitMembership.indexGitMembership(ctx);
        const member = await new File().edit(editStmt(filePath(trackedPath), "# Tracked by git\n\nrevised.\n", fullReplace), ctx);
        assert.equal(member.status, 202, "EDIT of a git-tracked member must still propose (202)");
        const created = await new File().edit(editStmt(filePath("new-note.md"), "fresh content\n"), ctx);
        assert.equal(created.status, 202, "EDIT of a new (non-existent) path must still propose creation (202)");
    });
});

test("{§fs-namespace} absolute paths printed by a shell READ and EDIT the existing member", async () => {
    await withGitWorkspace(async (root, ctx, db, trackedPath) => {
        await GitMembership.indexGitMembership(ctx);
        const { stdout } = await execFileP("sh", ["-c", 'printf "%s/%s\\n" "$PWD" "$1"', "path-fixture", trackedPath], { cwd: root });
        const abs = stdout.trim();
        assert.equal(abs, join(root, trackedPath));
        const read = await readFileScheme(readStmt(filePath(abs)), ctx);
        assert.equal(read.status, 200);
        assert.equal(read.content, "# Tracked by git\n\nThis file is a git member.\n");

        const file = new File();
        const revised = "# Tracked by git\n\nrevised.\n";
        const edit = await file.edit(editStmt(filePath(abs), revised, fullReplace), ctx);
        assert.equal(edit.status, 202);
        assert.equal((edit.attrs as { path: string }).path, trackedPath);
        const applied = await file.applyResolution({ attrs: edit.attrs as WriteAttrs, metadata: null }, ctx);
        assert.equal(applied.status, 200);
        assert.equal(await readFile(abs, "utf8"), revised);
        await assert.rejects(readFile(join(root, abs.slice(1))), { code: "ENOENT" });
        const keys = await db.test_file_pathnames.all<{ pathname: string }>({ workspace_id: ctx.workspaceId });
        assert.deepEqual(keys.map(({ pathname }) => pathname), [trackedPath]);
    });
});

type WriteAttrs = { path: string; canonical: string; patched: string; baseSig: string | null };

test("{§membership} an out-of-band disk change between propose and accept is an edit collision, never a clobber", async () => {
    await withGitWorkspace(async (root, ctx, _db, trackedPath) => {
        await GitMembership.indexGitMembership(ctx); // snapshot: body channel + synced_sig, both from disk
        const file = new File();

        // The model proposes an edit against the snapshot it READ.
        const proposal = await file.edit(editStmt(filePath(trackedPath), "# Tracked by git\n\nthe model's revision.\n", fullReplace), ctx);
        assert.equal(proposal.status, 202, "edit proposes (202)");

        // An ambient writer (the user's editor, a build step, a sibling session) changes the file on
        // disk after the proposal was computed — the captured revision must reject that drift.
        const ambient = "# Tracked by git\n\nAMBIENT out-of-band change — written under the paused proposal, clearly a different size.\n";
        await writeFile(join(root, trackedPath), ambient, "utf8");

        // Accept. body omitted, so a successful write would land attrs.patched (the full proposed
        // content) — which is exactly what must NOT happen now that disk has drifted from baseSig.
        const applied = await file.applyResolution({ attrs: proposal.attrs as WriteAttrs, metadata: null }, ctx);
        assert.equal(applied.status, 409, "a drifted disk is an edit collision, not a silent clobber");
        assert.equal(applied.problem?.type, "https://problems.plurnk.xyz/engine/edit/edit-collision");
        assert.equal(applied.outcome, "edit_collision", "the proposal lifecycle retains the neutral collision outcome");

        // The ambient change SURVIVES untouched — nothing got clever, nothing clobbered.
        assert.equal(await readFile(join(root, trackedPath), "utf8"), ambient, "the ambient out-of-band change is preserved, not overwritten by the stale proposal");
    });
});

test("{§membership} with no drift the proposal lands and restamps the snapshot signature", async () => {
    await withGitWorkspace(async (root, ctx, db, trackedPath) => {
        await GitMembership.indexGitMembership(ctx);
        const file = new File();
        const sigBefore = await db.crud_get_member_sig.get<{ synced_sig: string | null }>({ workspace_id: ctx.workspaceId, scheme: "file", authority: "", pathname: trackedPath });

        const revised = "# Tracked by git\n\nlanded cleanly.\n";
        const proposal = await file.edit(editStmt(filePath(trackedPath), revised, fullReplace), ctx);
        assert.equal(proposal.status, 202);

        const applied = await file.applyResolution({ attrs: proposal.attrs as WriteAttrs, metadata: null }, ctx);
        assert.equal(applied.status, 200, "no drift → the write lands");
        assert.equal(await readFile(join(root, trackedPath), "utf8"), revised, "disk holds the proposed content");

        // synced_sig is restamped to the landed write, so the next reconcile doesn't narrate our
        // own write back at the model as an FsDivergence.
        const sigAfter = await db.crud_get_member_sig.get<{ synced_sig: string | null }>({ workspace_id: ctx.workspaceId, scheme: "file", authority: "", pathname: trackedPath });
        assert.notEqual(sigAfter?.synced_sig, sigBefore?.synced_sig, "synced_sig advanced to the landed write");
        assert.notEqual(sigAfter?.synced_sig, null, "synced_sig is stamped, not cleared");
    });
});

test("{§membership} resolveOverlay reports members and the files an exclusion removed", async () => {
    await withGitWorkspace(async (root, ctx, db, trackedPath) => {
        await writeFile(join(root, "readme.md"), "# readme\n");
        await writeFile(join(root, "secret.md"), "secret\n");
        await execFileP("git", ["add", "readme.md", "secret.md"], { cwd: root, env: hermeticGitEnv() });
        await execFileP("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--no-verify", "-q", "-m", "more"], { cwd: root, env: hermeticGitEnv() });
        await db.crud_insert_family_workspace_constraint.run({ workspace_id: ctx.workspaceId, effect: "exclude", glob: "secret.md", source: "members" });

        const overlay = await GitMembership.resolveOverlay(db, ctx.workspaceId, undefined, undefined);
        assert.ok(overlay !== null);
        assert.ok(overlay.members.includes(trackedPath) && overlay.members.includes("readme.md"), "tracked files resolve as members");
        assert.ok(!overlay.members.includes("secret.md"), "an excluded file is not in members");
        assert.deepEqual(overlay.excluded, ["secret.md"], "an excluded tracked file is reported — the same (ls-files ∪ include) − exclude the manifest uses");
        assert.ok(overlay.tracked.has("secret.md"), "an exclusion does not un-track");
    });
});

test("{§machine-processes} membership is the workspace's — one overlay, identical for every session", async () => {
    await withGitWorkspace(async (_root, ctx, db, trackedPath) => {
        // ctx.sessionId is session A. Create a second session on the same workspace.
        const sessionB = await insertSession(db, ctx.workspaceId);
        assert.notEqual(ctx.sessionId, sessionB, "two distinct sessions on one workspace");

        // The overlay is keyed by workspace, never session: resolveOverlay and crud_find_workspace_entry
        // both take workspace_id ONLY (membership lives on workspace_constraints.workspace_id; entry workspace derives from owner —
        // there is no session_id anywhere in it). So both sessions resolve the IDENTICAL member set; there is no
        // per-session overlay to diverge. Divergent membership is a different workspace ({§machine-processes}).
        const overlay = await GitMembership.resolveOverlay(db, ctx.workspaceId, undefined, undefined);
        assert.ok(overlay?.members.includes(trackedPath), "the git-tracked file is a member of the workspace (not of a session)");
        const entry = await db.crud_find_workspace_entry.get<{ id: number }>({ workspace_id: ctx.workspaceId, scheme: "file", authority: "", pathname: trackedPath });
        assert.ok(entry, "the member entry is commons-owned — session A and session B see the identical row (one filesystem)");
    });
});

// ───────────── {§membership} overlay and divergence composition ─────────────

test("{§membership} an exclusion drops a tracked file from membership, reconciling already-registered ones", async () => {
    await withGitWorkspace(async (_root, ctx, db, trackedPath) => {
        // trackedPath is already a git member (withGitWorkspace established it).
        const before = await db.crud_find_workspace_entry.get<{ id: number }>({ workspace_id: ctx.workspaceId, scheme: "file", authority: "", pathname: trackedPath});
        assert.notEqual(before, undefined, "precondition: the tracked file is a member");

        // A definition excludes it; membership re-resolves.
        await db.crud_insert_family_workspace_constraint.run({ workspace_id: ctx.workspaceId, effect: "exclude", glob: trackedPath, source: "members" });
        await GitMembership.resolveGitMembership(db, ctx.workspaceId, undefined);

        // Reconciled: the entry is GONE (un-registered), not merely hidden — entries == members.
        const after = await db.crud_find_workspace_entry.get<{ id: number }>({ workspace_id: ctx.workspaceId, scheme: "file", authority: "", pathname: trackedPath});
        assert.equal(after, undefined, "an ignored member must be un-registered");
        const read = await readFileScheme(readStmt(filePath(trackedPath)), ctx);
        assert.equal(read.status, 404, "an ignored file is not readable — it left the curated surface");
    });
});

test("{§membership} an include glob admits an untracked file git misses", async () => {
    await withGitWorkspace(async (root, ctx, db) => {
        // untracked.md is NOT in git; an add-glob admits it as a member via the scan.
        await writeFile(join(root, "untracked.md"), "# git misses me\n");
        await db.crud_insert_family_workspace_constraint.run({ workspace_id: ctx.workspaceId, effect: "include", glob: "*.md", source: "members" });
        await GitMembership.indexGitMembership(ctx);  // resolve membership + materialize (production's per-turn pass)
        const member = await db.crud_find_workspace_entry.get<{ id: number }>({ workspace_id: ctx.workspaceId, scheme: "file", authority: "", pathname: "untracked.md" });
        assert.notEqual(member, undefined, "an add-glob admits an untracked match as a member");
        // And it's readable — admitted to the curated surface.
        const read = await readFileScheme(readStmt(filePath("untracked.md")), ctx);
        assert.equal(read.status, 200, "an added file is readable");
    });
});


test("{§membership} out-of-band change to a member remains truthful runtime-actor evidence", async () => {
    await withGitWorkspace(async (root, ctx, db, trackedPath) => {
        // EMI re-reads disk each turn (git materialization); the build-time delta
        // detector turns an out-of-band member change into a runtime-owned EDIT
        // naming the file (source="file"). It must remain durable without becoming
        // an ambient packet event for an unrelated model session.
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({
            contextWindow: 100000,
            responses: [mockResponse([completeStmt()]), mockResponse([completeStmt()])],
        });

        await engine.runTurn({ provider, workspaceId: ctx.workspaceId, sessionId: ctx.sessionId, loopId: ctx.loopId, messages: [] });

        await writeFile(join(root, trackedPath), "# Tracked by git\n\nEDITED OUT OF BAND.\n");

        const t2 = await engine.runTurn({ provider, workspaceId: ctx.workspaceId, sessionId: ctx.sessionId, loopId: ctx.loopId, messages: [] });
        const row = await db.test_get_packet.get<{ packet: string }>({ id: t2.turnId });
        if (row === undefined) throw new Error("turn packet not found");
        const log = logEntries(JSON.parse(row.packet));
        assert.equal(log.some((r) => r.origin === "_plurnk" && JSON.stringify(r).includes(trackedPath)), false,
            "runtime reconciliation does not broadcast the project-file change into the model session");
        const runtimeSession = await db.envelope_get_session_by_name.get<{ id: number }>({
            workspace_id: ctx.workspaceId,
            name: "_plurnk",
        });
        assert.ok(runtimeSession, "filesystem reconciliation owns the runtime session");
        const runtimeRows = await db.engine_render_log.all<{ source: string | null; op: string; pathname: string | null }>({
            session_id: runtimeSession.id,
        });
        assert.ok(runtimeRows.some(({ source, op, pathname }) => source === "file" && op === "EDIT" && pathname === trackedPath),
            "EMI preserves the divergence as an exact runtime-actor operation row");
    });
});

// ─────────────── {§membership} incremental and concurrent passes ───────────────

test("{§membership} a member unchanged on disk is not re-tokenized on the next pass", async () => {
    await withGitWorkspace(async (_root, ctx) => {
        let calls = 0;
        const counting: PlurnkSchemeContext = { ...ctx, weigh: (t: string) => { calls += 1; return Math.ceil(t.length / 4); } };
        await GitMembership.indexGitMembership(counting);
        const afterFirst = calls;
        assert.ok(afterFirst > 0, "precondition: the first sync tokenizes the member");
        await GitMembership.indexGitMembership(counting);
        assert.equal(calls, afterFirst, "an unchanged member must not be re-tokenized on the second pass — work is proportional to change");
    });
});

test("{§derivation-dedup-parallel}: an oversized member degrades to an addressable 413 without risking an empty-baseline edit", async () => {
    await withGitWorkspace(async (root, ctx, _db, trackedPath) => {
        const previous = process.env.PLURNK_SERVICE_FILE_MATERIALIZE_MAX_BYTES;
        const original = await readFile(join(root, trackedPath), "utf8");
        process.env.PLURNK_SERVICE_FILE_MATERIALIZE_MAX_BYTES = "1";
        try {
            const prematerializationEdit = await new File().edit(
                editStmt(filePath(trackedPath), "replacement\n", fullReplace),
                ctx,
            );
            assert.equal(prematerializationEdit.status, 413, "the edit gate does not depend on a completed background warm for safety");
            assert.equal(await readFile(join(root, trackedPath), "utf8"), original);

            assert.deepEqual(await GitMembership.indexGitMembership(ctx), [], "initial materialization is not filesystem-divergence evidence");

            const engine = new Engine({
                db: ctx.db,
                schemes: new SchemeRegistry(),
                weigh: ctx.weigh,
                mimetypes: ctx.mimetypes,
            });
            await engine.warmWorkspaceDerivations(ctx.workspaceId);

            const rejectedRead = await readFileScheme(readStmt(filePath(trackedPath)), ctx);
            assert.equal(rejectedRead.status, 413, "the member remains addressable through its durable producer failure");
            assert.equal(rejectedRead.content, "", "the size diagnostic is not fabricated as file content");
            assert.match(rejectedRead.problem?.detail ?? "", /tracked\.md.*1-byte.*materialization limit/i);
            assert.equal(rejectedRead.problem?.maximumBytes, 1);
            assert.equal(rejectedRead.problem?.observedBytes, Buffer.byteLength(original));

            const rejectedEdit = await new File().edit(
                editStmt(filePath(trackedPath), "replacement\n", fullReplace),
                ctx,
            );
            assert.equal(rejectedEdit.status, 413, "EDIT cannot mistake an unavailable snapshot for an empty file");
            const { instance, ...readProblem } = rejectedRead.problem;
            assert.ok(instance, "the dispatched READ names its own recorded row");
            assert.deepEqual(rejectedEdit.problem, readProblem, "READ and EDIT preserve one canonical source-limit failure");
            assert.equal(await readFile(join(root, trackedPath), "utf8"), original, "the oversized source remains untouched");

            process.env.PLURNK_SERVICE_FILE_MATERIALIZE_MAX_BYTES = "1024";
            assert.deepEqual(await GitMembership.indexGitMembership(ctx), [], "a policy-only rematerialization is not narrated as disk drift");
            const admittedRead = await readFileScheme(readStmt(filePath(trackedPath)), ctx);
            assert.equal(admittedRead.status, 200, "raising the ceiling rematerializes an unchanged member");
            assert.equal(admittedRead.content, original);

            process.env.PLURNK_SERVICE_FILE_MATERIALIZE_MAX_BYTES = "1";
            assert.deepEqual(await GitMembership.indexGitMembership(ctx), [], "lowering the policy reclassifies the same source without fake EMI");
            assert.equal(
                (await readFileScheme(readStmt(filePath(trackedPath)), ctx)).status,
                413,
                "lowering the ceiling reclassifies an unchanged member",
            );

            process.env.PLURNK_SERVICE_FILE_MATERIALIZE_MAX_BYTES = "104857601";
            await assert.rejects(
                GitMembership.indexGitMembership(ctx),
                /between 1 and 104857600/,
                "the operator cannot configure snapshots beyond the canonical channel's storage bound",
            );
            process.env.PLURNK_SERVICE_FILE_MATERIALIZE_MAX_BYTES = "1";
            assert.deepEqual(
                await GitMembership.indexGitMembership(ctx),
                [],
                "a rejected coalesced pass releases ownership and the corrected request can retry",
            );
        } finally {
            if (previous === undefined) delete process.env.PLURNK_SERVICE_FILE_MATERIALIZE_MAX_BYTES;
            else process.env.PLURNK_SERVICE_FILE_MATERIALIZE_MAX_BYTES = previous;
        }
    });
});

test("{§membership} overlapping startup and turn membership requests coalesce into one workspace pass", async () => {
    await withGitWorkspace(async (_root, ctx, db, trackedPath) => {
        let calls = 0;
        const slow: PlurnkSchemeContext = {
            ...ctx,
            weigh: (text: string) => {
                calls += 1;
                return Math.ceil(text.length / 4);
            },
        };
        await Promise.all([
            GitMembership.indexGitMembership(slow),
            GitMembership.indexGitMembership(slow),
        ]);
        const entry = await db.crud_find_workspace_entry.get<{ id: number }>({
            workspace_id: ctx.workspaceId,
            scheme: "file",
            authority: "",
            pathname: trackedPath,
        });
        assert.ok(entry !== undefined);
        const channels = await db.test_list_channels_for_entry.all<{ name: string }>({ entry_id: entry.id });
        assert.deepEqual(channels.map((row) => row.name), ["body"]);
        assert.equal(calls, 1, "both callers share one materialization pass instead of queueing a redundant forest scan");
    });
});

test("{§membership} PLURNK_SERVICE_GIT_AUTO=0 leaves definitions as the only grantor", async () => {
    await withGitWorkspace(async (_root, ctx, db, trackedPath) => {
        const prev = process.env.PLURNK_SERVICE_GIT_AUTO;
        process.env.PLURNK_SERVICE_GIT_AUTO = "0";
        try {
            await GitMembership.resolveGitMembership(db, ctx.workspaceId, undefined);
            const member = await db.crud_find_workspace_entry.get<{ id: number }>({
                workspace_id: ctx.workspaceId, scheme: "file", authority: "", pathname: trackedPath,
            });
            assert.equal(member, undefined, "AUTO=0 stops the repository from admitting its own tracked files");
        } finally {
            if (prev === undefined) delete process.env.PLURNK_SERVICE_GIT_AUTO; else process.env.PLURNK_SERVICE_GIT_AUTO = prev;
        }
    });
});

test("{§operator-config-workspace-settings} PLURNK_SERVICE_GIT_ALLOWED=0 denies all git membership, un-re-enableable", async () => {
    await withGitWorkspace(async (_root, ctx, db, trackedPath) => {
        const prev = process.env.PLURNK_SERVICE_GIT_ALLOWED;
        process.env.PLURNK_SERVICE_GIT_ALLOWED = "0";
        try {
            await GitMembership.resolveGitMembership(db, ctx.workspaceId, undefined);
            const member = await db.crud_find_workspace_entry.get<{ id: number }>({ workspace_id: ctx.workspaceId, scheme: "file", authority: "", pathname: trackedPath});
            assert.equal(member, undefined, "ALLOWED=0 must deny git membership — no member resolves");
        } finally {
            if (prev === undefined) delete process.env.PLURNK_SERVICE_GIT_ALLOWED; else process.env.PLURNK_SERVICE_GIT_ALLOWED = prev;
        }
    });
});

test("{§tokenomics}: NUL-headed content is binary regardless of the extension label", async () => {
    // Byte evidence overrides the label before materialization and derivation.
    await withGitWorkspace(async (root, ctx, db) => {
        const evil = "blob.md"; // the most trusted-looking extension
        await writeFile(join(root, evil), Buffer.concat([Buffer.from("MZ"), Buffer.alloc(64, 0), Buffer.from("binary tail")]));
        await execFileP("git", ["add", evil], { cwd: root, env: hermeticGitEnv() });
        await GitMembership.indexGitMembership(ctx);
        const row = await db.ops_read_channel.get<{ content: string; mimetype: string }>({
            workspace_id: ctx.workspaceId, scheme: "file", authority: "", pathname: evil, channel: "body",
        });
        assert.ok(row !== undefined, "the member materialized");
        assert.equal(row.mimetype, "application/octet-stream", "the sniff overrode the label");
        assert.equal(row.content, "", "binary bodies are empty markers");
        const fts = await db.test_fts_search.all<{ pathname: string }>({
            workspace_id: ctx.workspaceId,
            query: "binary OR tail",
        });
        assert.deepEqual(fts, [], "no keyword ghost of the blob");
    });
});
});

describe("file-integrity", () => {
const original = "old content\n";
const external = "new content\n";

const fixture = async (t: TestContext) => {
    const root = await fs.mkdtemp(join(tmpdir(), "plurnk-file-integrity-"));
    const db = await openMigrated(join(root, "plurnk.db"));
    t.after(async () => {
        await db.close();
        await fs.rm(root, { recursive: true, force: true });
    });
    const workspaceId = await insertWorkspace(db, "integrity");
    await rootWorkspace(db, workspaceId, root);
    const sessionId = await insertSession(db, workspaceId);
    await ownSession(db, workspaceId, sessionId);
    const loopId = await insertLoop(db, sessionId, 1, "integrity");
    const turnId = await insertTurn(db, loopId, 1, 102);
    const ids = { workspaceId, sessionId, loopId, turnId };
    const ctx = makeSchemeCtx({ db, ...ids, mimetypes: DEFAULT_MIMETYPES });
    const file = new File();
    const path = join(root, "doc.md");
    const creating = await file.edit(editStmt(localPath("doc.md"), original), ctx);
    assert.equal(creating.status, 202);
    assert.equal((await file.applyResolution({ attrs: creating.attrs as never, metadata: null }, ctx)).status, 200);
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES, weigh: ctx.weigh });
    return { root, db, ids, ctx, file, path, engine };
};

for (const scope of ["sessions", "workspaces", "aliases"] as const) {
    test(`{§file-snapshot-revision}: competing ${scope} cannot both overwrite one baseline`, async (t) => {
        const fx = await fixture(t);
        const workspaceId = scope !== "workspaces" ? fx.ids.workspaceId : await insertWorkspace(fx.db, "second");
        const pathname = scope === "aliases" ? "alias.md" : "doc.md";
        if (scope === "aliases") {
            await fs.symlink("doc.md", join(fx.root, pathname));
            await fx.db.crud_register_workspace_member.get({ workspace_id: workspaceId, scheme: "file", authority: "", pathname, membership_origin: "constraint" });
        }
        if (scope === "workspaces") {
            await rootWorkspace(fx.db, workspaceId, fx.root);
            await fx.db.crud_register_workspace_member.get({ workspace_id: workspaceId, scheme: "file", authority: "", pathname: "doc.md", membership_origin: "constraint" });
        }
        const sessionId = await insertSession(fx.db, workspaceId);
        const secondCtx = makeSchemeCtx({ ...fx.ctx, workspaceId, sessionId });
        await MembershipMaterialization.materializeMember(pathname, fx.root, secondCtx, new Map());
        const first = await fx.file.edit(editStmt(localPath("doc.md"), "first edit!\n", fullReplace), fx.ctx);
        const second = await fx.file.edit(editStmt(localPath(pathname), "second edit\n", fullReplace), secondCtx);
        assert.equal(first.status, 202);
        assert.equal(second.status, 202);
        const barrier = Promise.withResolvers<void>();
        let arrivals = 0;
        const parse = DbProjectionCaps.prototype.parseIssueTransition;
        t.mock.method(DbProjectionCaps.prototype, "parseIssueTransition", async function (this: DbProjectionCaps, ...args: Parameters<typeof parse>) {
            if (++arrivals === 2) barrier.resolve();
            await barrier.promise;
            return parse.apply(this, args);
        });
        const results = await Promise.all([
            fx.file.applyResolution({ attrs: first.attrs as never, metadata: null }, fx.ctx),
            fx.file.applyResolution({ attrs: second.attrs as never, metadata: null }, secondCtx),
        ]);
        assert.deepEqual(results.map(({ status }) => status).toSorted((a, b) => a - b), [200, 409]);
        const winner = results[0].status === 200 ? "first edit!\n" : "second edit\n";
        assert.equal(await fs.readFile(fx.path, "utf8"), winner);
        const rejected = results.find(({ status }) => status === 409);
        assert.match(rejected?.problem?.type ?? "", /edit-collision$/);
    });
}

test("{§file-snapshot-revision}: source revisions stay internal to ordinary READ receipts", async (t) => {
    const fx = await fixture(t);
    const { workspaceId, sessionId } = fx.ids;
    const result = await clientRead(fx.engine, fx.db, { workspaceId, sessionId, statement: readStmt(localPath("doc.md")) });
    assert.equal(result.status, 200);
    assert.match(String((result as { content?: unknown }).content), /old content/);
    assert.doesNotMatch(JSON.stringify(result), /fileRevision|synced_sig|fingerprint/);
});

test("{§file-snapshot-revision}: deletion of an unversioned projection preserves its divergence evidence", async (t) => {
    const fx = await fixture(t);
    await EntryCrud.writeEntry({ authority: "", pathname: "doc.md" }, {
        channels: { body: { content: original, mimetype: "text/markdown" } },
    }, fx.ctx, "file");
    await fs.unlink(fx.path);
    const divergence = await MembershipMaterialization.materializeMember("doc.md", fx.root, fx.ctx, new Map());
    assert.equal(divergence?.before, original);
    assert.equal(divergence?.after, "");
    assert.deepEqual((await fx.file.readEntry("doc.md", fx.ctx)).entry?.channels, {});
    assert.equal(await MembershipMaterialization.materializeMember("doc.md", fx.root, fx.ctx, new Map()), null);
});

for (const mutation of ["EDIT", "KILL"] as const) {
    for (const drift of ["same-size-and-mtime", "replacement", "missing", "directory"] as const) {
        test(`{§file-snapshot-revision} {§file-snapshot-revision}: ${mutation} preserves ${drift} drift`, async (t) => {
            const fx = await fixture(t);
            await fs.utimes(fx.path, 1_700_000_000, 1_700_000_000);
            await MembershipMaterialization.materializeMember("doc.md", fx.root, fx.ctx, new Map());
            const proposal = mutation === "EDIT"
                ? await fx.file.edit(editStmt(localPath("doc.md"), "proposed\n", fullReplace), fx.ctx)
                : await fx.file.deleteEntry("doc.md", fx.ctx);
            assert.equal(proposal.status, 202);
            if (drift === "missing") await fs.unlink(fx.path);
            else if (drift === "directory") {
                await fs.unlink(fx.path);
                await fs.mkdir(fx.path);
            }
            else if (drift === "replacement") {
                const other = join(fx.root, "other.md");
                await fs.writeFile(other, external);
                await fs.rename(other, fx.path);
            } else {
                await fs.writeFile(fx.path, external);
                await fs.utimes(fx.path, 1_700_000_000, 1_700_000_000);
            }
            const result = await fx.file.applyResolution({ attrs: proposal.attrs as never, metadata: null }, fx.ctx);
            assert.equal(result.status, 409);
            assert.match(result.problem?.type ?? "", /edit-collision$/);
            if (drift === "missing") await assert.rejects(fs.stat(fx.path), { code: "ENOENT" });
            else if (drift === "directory") assert.equal((await fs.stat(fx.path)).isDirectory(), true);
            else assert.equal(await fs.readFile(fx.path, "utf8"), external);
        });
    }
}

test("{§file-snapshot-revision}: reviewed MOVE retains the selected source revision and reports its written destination", async (t) => {
    const fx = await fixture(t);
    const pending = Promise.withResolvers<number>();
    fx.engine.onProposalPending((event) => pending.resolve(event.logEntryId));
    const moving = fx.engine.dispatch({ ...fx.ids,
        statement: moveStmt(localPath("doc.md"), localPath("destination.md")),
        sequence: 1, origin: "model",
    });
    const logEntryId = await Promise.race([pending.promise, moving.then((result) => assert.fail(`Expected review: ${JSON.stringify(result)}`))]);
    await fs.writeFile(fx.path, external);
    await MembershipMaterialization.materializeMember("doc.md", fx.root, fx.ctx, new Map());
    fx.engine.resolveProposal(logEntryId, { decision: "accept" });
    const result = await moving;
    assert.equal(result.status, 409, JSON.stringify(result));
    assert.equal(await fs.readFile(fx.path, "utf8"), external);
    assert.equal(await fs.readFile(join(fx.root, "destination.md"), "utf8"), original);
    assert.deepEqual(result.effects, [{ target: "destination.md", action: "create" }]);
    assert.equal(result.problem?.destinationWritten, true);
});

test("{§file-snapshot-revision}: same-size content with restored mtime is rematerialized", async (t) => {
    const fx = await fixture(t);
    await fs.utimes(fx.path, 1_700_000_000, 1_700_000_000);
    await MembershipMaterialization.materializeMember("doc.md", fx.root, fx.ctx, new Map());
    await fs.writeFile(fx.path, external);
    await fs.utimes(fx.path, 1_700_000_000, 1_700_000_000);
    const divergence = await MembershipMaterialization.materializeMember("doc.md", fx.root, fx.ctx, new Map());
    assert.equal(divergence?.before, original);
    assert.equal(divergence?.after, external);
    assert.equal((await fx.file.readEntry("doc.md", fx.ctx)).entry?.channels.body?.content, external);
});

test("{§file-snapshot-revision}: an external update after projection publication is not restamped as our write", async (t) => {
    const fx = await fixture(t);
    await MembershipMaterialization.materializeMember("doc.md", fx.root, fx.ctx, new Map());
    const proposed = "replacement from model\n";
    const proposal = await fx.file.edit(editStmt(localPath("doc.md"), proposed, fullReplace), fx.ctx);
    assert.equal(proposal.status, 202);
    const publish = EntryCrud.writeEntry;
    t.mock.method(EntryCrud, "writeEntry", async (...args: Parameters<typeof publish>) => {
        const result = await publish(...args);
        if (args[0].pathname === "doc.md" && args[3] === "file") await fs.writeFile(fx.path, external);
        return result;
    });
    const result = await fx.file.applyResolution({ attrs: proposal.attrs as never, metadata: null }, fx.ctx);
    assert.equal(result.status, 200);
    t.mock.restoreAll();
    const divergence = await MembershipMaterialization.materializeMember("doc.md", fx.root, fx.ctx, new Map());
    assert.equal(divergence?.before, proposed);
    assert.equal(divergence?.after, external);
    assert.equal((await fx.file.readEntry("doc.md", fx.ctx)).entry?.channels.body?.content, external);
});

test("{§file-snapshot-revision}: creation rollback preserves another writer's replacement", async (t) => {
    const fx = await fixture(t);
    const target = join(fx.root, "new.md");
    const replacement = join(fx.root, "external.md");
    const proposal = await fx.file.edit(editStmt(localPath("new.md"), original), fx.ctx);
    assert.equal(proposal.status, 202);
    t.mock.method(GitMembership, "incorporateCreation", async () => {
        await fs.writeFile(replacement, external);
        await fs.rename(replacement, target);
        throw new Error("fixture: incorporation failed after external replacement");
    });
    const result = await fx.file.applyResolution({ attrs: proposal.attrs as never, metadata: null }, fx.ctx);
    assert.equal(result.status, 500);
    assert.match(result.problem?.type ?? "", /creation-rollback-failed$/);
    assert.equal(await fs.readFile(target, "utf8"), external);
});

test("{§file-snapshot-revision}: creation rollback follows its published identity, not a retargeted parent", async (t) => {
    const fx = await fixture(t);
    await fs.mkdir(join(fx.root, "first"));
    await fs.mkdir(join(fx.root, "second"));
    const alias = join(fx.root, "alias");
    await fs.symlink("first", alias);
    const proposal = await fx.file.edit(editStmt(localPath("alias/new.md"), original), fx.ctx);
    assert.equal(proposal.status, 202);
    t.mock.method(GitMembership, "incorporateCreation", async () => {
        await fs.unlink(alias);
        await fs.symlink("second", alias);
        throw new Error("fixture: incorporation failed after the parent changed");
    });
    const result = await fx.file.applyResolution({ attrs: proposal.attrs as never, metadata: null }, fx.ctx);
    assert.equal(result.status, 500);
    assert.match(result.problem?.type ?? "", /creation-incorporation-failed$/);
    await assert.rejects(fs.stat(join(fx.root, "first/new.md")), { code: "ENOENT" });
    await assert.rejects(fs.stat(join(fx.root, "second/new.md")), { code: "ENOENT" });
    assert.equal(await fs.readlink(alias), "second");
});

for (const existing of [true, false]) {
    test(`{§file-snapshot-revision}: a partial stage write preserves ${existing ? "the original" : "absence"}`, async (t) => {
        const fx = await fixture(t);
        const pathname = existing ? "doc.md" : "new.md";
        const proposal = await fx.file.edit(editStmt(localPath(pathname), "replacement\n", existing ? fullReplace : null), fx.ctx);
        assert.equal(proposal.status, 202);
        const open = fs.open;
        t.mock.method(fs, "open", async (...args: Parameters<typeof open>) => {
            const handle = await open(...args);
            if (args[1] === "wx") {
                const write = handle.writeFile.bind(handle);
                t.mock.method(handle, "writeFile", async () => {
                    await write("partial");
                    throw Object.assign(new Error("fixture: disk full"), { code: "ENOSPC" });
                });
            }
            return handle;
        });
        const result = await fx.file.applyResolution({ attrs: proposal.attrs as never, metadata: null }, fx.ctx);
        assert.equal(result.status, 500);
        assert.match(result.problem?.type ?? "", /write-failed$/);
        assert.equal(result.problem?.published, false);
        if (existing) assert.equal(await fs.readFile(fx.path, "utf8"), original);
        else await assert.rejects(fs.stat(join(fx.root, pathname)), { code: "ENOENT" });
        assert.deepEqual((await fs.readdir(fx.root)).filter((name) => name.startsWith(".plurnk-write-")), []);
    });
}

test("{§file-snapshot-revision}: final validation follows staging and fallible receipt preparation", async (t) => {
    const fx = await fixture(t);
    const proposal = await fx.file.edit(editStmt(localPath("doc.md"), "replacement\n", fullReplace), fx.ctx);
    const open = fs.open;
    t.mock.method(fs, "open", async (...args: Parameters<typeof open>) => {
        const handle = await open(...args);
        if (args[1] === "wx") {
            const sync = handle.sync.bind(handle);
            t.mock.method(handle, "sync", async () => {
                await sync();
                await fs.writeFile(fx.path, external);
            });
        }
        return handle;
    });
    const result = await fx.file.applyResolution({ attrs: proposal.attrs as never, metadata: null }, fx.ctx);
    assert.equal(result.status, 409);
    assert.match(result.problem?.type ?? "", /edit-collision$/);
    assert.equal(await fs.readFile(fx.path, "utf8"), external);
});

test("{§fs-write-surface}: an occupant appearing at publication is preserved", async (t) => {
    const fx = await fixture(t);
    const target = join(fx.root, "new.md");
    const proposal = await fx.file.edit(editStmt(localPath("new.md"), original), fx.ctx);
    const link = fs.link;
    t.mock.method(fs, "link", async (...args: Parameters<typeof link>) => {
        await fs.writeFile(target, external);
        return link(...args);
    });
    const result = await fx.file.applyResolution({ attrs: proposal.attrs as never, metadata: null }, fx.ctx);
    assert.equal(result.status, 409);
    assert.equal(await fs.readFile(target, "utf8"), external);
});

test("{§file-snapshot-revision}: creation revalidates a symlinked parent after staging", async (t) => {
    const fx = await fixture(t);
    await fs.mkdir(join(fx.root, "first"));
    await fs.mkdir(join(fx.root, "second"));
    const alias = join(fx.root, "alias");
    await fs.symlink("first", alias);
    const proposal = await fx.file.edit(editStmt(localPath("alias/new.md"), original), fx.ctx);
    assert.equal(proposal.status, 202);
    const open = fs.open;
    t.mock.method(fs, "open", async (...args: Parameters<typeof open>) => {
        const handle = await open(...args);
        if (args[1] === "wx") {
            const sync = handle.sync.bind(handle);
            t.mock.method(handle, "sync", async () => {
                await sync();
                await fs.unlink(alias);
                await fs.symlink("second", alias);
            });
        }
        return handle;
    });
    const result = await fx.file.applyResolution({ attrs: proposal.attrs as never, metadata: null }, fx.ctx);
    assert.equal(result.status, 409);
    assert.match(result.problem?.type ?? "", /edit-collision$/);
    for (const parent of ["first", "second"]) {
        await assert.rejects(fs.stat(join(fx.root, parent, "new.md")), { code: "ENOENT" });
    }
});

test("{§file-snapshot-revision}: replacement preserves mode and owner while hard links and open descriptors retain old bytes", async (t) => {
    const fx = await fixture(t);
    const other = join(fx.root, "linked.md");
    await fs.chmod(fx.path, 0o751);
    await fs.link(fx.path, other);
    const handle = await fs.open(fx.path, "r");
    t.after(() => handle.close());
    const before = await fs.stat(fx.path);
    await MembershipMaterialization.materializeMember("doc.md", fx.root, fx.ctx, new Map());
    const proposal = await fx.file.edit(editStmt(localPath("doc.md"), "replacement\n", fullReplace), fx.ctx);
    assert.equal((await fx.file.applyResolution({ attrs: proposal.attrs as never, metadata: null }, fx.ctx)).status, 200);
    const after = await fs.stat(fx.path);
    assert.equal(after.mode, before.mode);
    assert.equal(after.uid, before.uid);
    assert.equal(after.gid, before.gid);
    assert.notEqual(after.ino, before.ino);
    assert.equal(await fs.readFile(fx.path, "utf8"), "replacement\n");
    assert.equal(await fs.readFile(other, "utf8"), original);
    assert.equal(await handle.readFile("utf8"), original);
});

for (const binary of [false, true]) {
    for (const scoped of [false, true]) {
        test(`{§file-snapshot-revision}: ${binary ? "binary" : "text"} ${scoped ? "scoped" : "whole"} MOVE preserves source drift through review`, async (t) => {
            const fx = await fixture(t);
            const source = binary ? "source.png" : "doc.md";
            const initial = binary ? Buffer.from([0, 1, 2, 3]) : Buffer.from("one\ntwo\nthree\n");
            const changed = binary ? Buffer.from([0, 9, 8, 7]) : Buffer.from("new\ntwo\nthree\n");
            await fs.writeFile(join(fx.root, source), initial);
            if (binary) await fx.db.crud_register_workspace_member.get({ workspace_id: fx.ids.workspaceId, scheme: "file", authority: "", pathname: source, membership_origin: "constraint" });
            await MembershipMaterialization.materializeMember(source, fx.root, fx.ctx, new Map());
            const pending = Promise.withResolvers<number>();
            fx.engine.onProposalPending((event) => pending.resolve(event.logEntryId));
            const destination = binary ? "destination.png" : "destination.md";
            const moving = fx.engine.dispatch({ ...fx.ids,
                statement: moveStmt(localPath(source), localPath(destination), scoped ? { marks: [2, 2] } : null),
                sequence: 1, origin: "model",
            });
            const logEntryId = await Promise.race([pending.promise, moving.then((result) => assert.fail(`Expected review: ${JSON.stringify(result)}`))]);
            await fs.writeFile(join(fx.root, source), changed);
            await MembershipMaterialization.materializeMember(source, fx.root, fx.ctx, new Map());
            fx.engine.resolveProposal(logEntryId, { decision: "accept" });
            const result = await moving;
            assert.equal(result.status, 409, JSON.stringify(result));
            assert.equal(result.problem?.destinationWritten, true);
            assert.ok(Array.isArray(result.effects));
            assert.equal(result.effects.length, 1);
            assert.partialDeepStrictEqual(result.effects, [{ target: destination, action: "create" }]);
            assert.deepEqual(await fs.readFile(join(fx.root, source)), changed);
            assert.deepEqual(await fs.readFile(join(fx.root, destination)), scoped
                ? binary ? Buffer.from([1]) : Buffer.from("two\n") : initial);
        });
    }
}

test("{§file-snapshot-revision}: a scoped binary COPY does not rebase its destination during approval", async (t) => {
    const fx = await fixture(t);
    for (const [pathname, bytes] of [["source.bin", Buffer.from([0, 1])], ["target.bin", Buffer.from([0, 3, 4])]] as const) {
        await fs.writeFile(join(fx.root, pathname), bytes);
        await fx.db.crud_register_workspace_member.get({ workspace_id: fx.ids.workspaceId, scheme: "file", authority: "", pathname, membership_origin: "constraint" });
        await MembershipMaterialization.materializeMember(pathname, fx.root, fx.ctx, new Map());
    }
    const pending = Promise.withResolvers<number>();
    fx.engine.onProposalPending((event) => pending.resolve(event.logEntryId));
    const copying = fx.engine.dispatch({ ...fx.ids,
        statement: copyStmt(localPath("source.bin"), localPath("target.bin"), null, { marks: [2, 2] }),
        sequence: 1, origin: "model",
    });
    const logEntryId = await Promise.race([pending.promise, copying.then((result) => assert.fail(`Expected review: ${JSON.stringify(result)}`))]);
    const changed = Buffer.from([0, 8, 9]);
    await fs.writeFile(join(fx.root, "target.bin"), changed);
    await MembershipMaterialization.materializeMember("target.bin", fx.root, fx.ctx, new Map());
    fx.engine.resolveProposal(logEntryId, { decision: "accept" });
    const result = await copying;
    assert.equal(result.status, 409, JSON.stringify(result));
    assert.match(result.problem?.type ?? "", /edit-collision$/);
    assert.deepEqual(await fs.readFile(join(fx.root, "target.bin")), changed);
    assert.deepEqual(await fs.readFile(join(fx.root, "source.bin")), Buffer.from([0, 1]));
});

for (const changed of [false, true]) {
    test(`{§file-snapshot-revision}: oversized-file deletion ${changed ? "rejects content drift with identical metadata" : "accepts an unchanged captured revision"}`, async (t) => {
        const fx = await fixture(t);
        const previous = process.env.PLURNK_SERVICE_FILE_MATERIALIZE_MAX_BYTES;
        process.env.PLURNK_SERVICE_FILE_MATERIALIZE_MAX_BYTES = "1";
        t.after(() => {
            if (previous === undefined) delete process.env.PLURNK_SERVICE_FILE_MATERIALIZE_MAX_BYTES;
            else process.env.PLURNK_SERVICE_FILE_MATERIALIZE_MAX_BYTES = previous;
        });
        // Simulate a filesystem whose stat clock cannot distinguish these same-length writes.
        const fingerprint = (await FileSnapshot.observe(fx.path))!.fingerprint;
        t.mock.method(FileSnapshot, "fingerprint", () => fingerprint);
        await MembershipMaterialization.materializeMember("doc.md", fx.root, fx.ctx, new Map());
        const proposal = await fx.file.deleteEntry("doc.md", fx.ctx);
        assert.equal(proposal.status, 202);
        if (changed) await fs.writeFile(fx.path, external);
        const result = await fx.file.applyResolution({ attrs: proposal.attrs as never, metadata: null }, fx.ctx);
        if (changed) {
            assert.equal(result.status, 409);
            assert.match(result.problem?.type ?? "", /edit-collision$/);
            assert.equal(await fs.readFile(fx.path, "utf8"), external);
        } else {
            assert.equal(result.status, 200);
            await assert.rejects(fs.stat(fx.path), { code: "ENOENT" });
        }
    });
}

test("{§file-snapshot-revision}: database failure after replacement reports the effect and reconciliation recovers it", async (t) => {
    const fx = await fixture(t);
    const proposed = "landed on disk\n";
    const proposal = await fx.file.edit(editStmt(localPath("doc.md"), proposed, fullReplace), fx.ctx);
    t.mock.method(EntryCrud, "writeEntry", async () => { throw new Error("fixture: database publication failed"); });
    const result = await fx.file.applyResolution({ attrs: proposal.attrs as never, metadata: null }, fx.ctx);
    assert.equal(result.status, 500);
    assert.match(result.problem?.type ?? "", /materialization-failed$/);
    assert.deepEqual(result.effects, [{ target: "doc.md", action: "update" }]);
    assert.equal(await fs.readFile(fx.path, "utf8"), proposed);
    assert.equal((await fx.file.readEntry("doc.md", fx.ctx)).entry?.channels.body?.content, original);
    t.mock.restoreAll();
    await MembershipMaterialization.materializeMember("doc.md", fx.root, fx.ctx, new Map());
    assert.equal((await fx.file.readEntry("doc.md", fx.ctx)).entry?.channels.body?.content, proposed);
});

test("{§file-snapshot-revision}: a failed channel publication rolls back its source revision too", async (t) => {
    const fx = await fixture(t);
    const before = await fx.file.readEntry("doc.md", fx.ctx);
    await assert.rejects(EntryCrud.writeEntry({ authority: "", pathname: "doc.md" }, {
        channels: { body: { content: "rejected", mimetype: "text/markdown", state: "invalid" as never } },
    }, fx.ctx, "file", { syncedSig: "rejected-revision" }), /CHECK constraint failed: state IN/);
    assert.deepEqual(await fx.file.readEntry("doc.md", fx.ctx), before);
});

for (const retargeted of [false, true]) {
    test(`{§file-snapshot-revision}: an in-project symlink ${retargeted ? "cannot redirect a pending edit" : "retains its link after editing the target"}`, async (t) => {
        const fx = await fixture(t);
        const alias = join(fx.root, "alias.md");
        await fs.symlink("doc.md", alias);
        await fx.db.crud_register_workspace_member.get({ workspace_id: fx.ids.workspaceId, scheme: "file", authority: "", pathname: "alias.md", membership_origin: "constraint" });
        await MembershipMaterialization.materializeMember("alias.md", fx.root, fx.ctx, new Map());
        const proposal = await fx.file.edit(editStmt(localPath("alias.md"), "replacement\n", fullReplace), fx.ctx);
        assert.equal(proposal.status, 202);
        if (retargeted) {
            await fs.writeFile(join(fx.root, "other.md"), external);
            await fs.unlink(alias);
            await fs.symlink("other.md", alias);
        }
        const result = await fx.file.applyResolution({ attrs: proposal.attrs as never, metadata: null }, fx.ctx);
        assert.equal(result.status, retargeted ? 409 : 200);
        assert.equal(await fs.readFile(fx.path, "utf8"), retargeted ? original : "replacement\n");
        assert.equal(await fs.readlink(alias), retargeted ? "other.md" : "doc.md");
        if (retargeted) assert.equal(await fs.readFile(join(fx.root, "other.md"), "utf8"), external);
    });
}

test("{§file-snapshot-revision}: reconciliation settles before a same-file commit while another file progresses", async (t) => {
    const fx = await fixture(t);
    const proposal = await fx.file.edit(editStmt(localPath("doc.md"), "replacement\n", fullReplace), fx.ctx);
    const independent = await fx.file.edit(editStmt(localPath("independent.md"), "independent\n"), fx.ctx);
    // Invalidate the projection, requiring a real materialization publication.
    await EntryCrud.writeEntry({ authority: "", pathname: "doc.md" }, {
        channels: { body: { content: original, mimetype: "text/markdown" } },
    }, fx.ctx, "file");
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let materializing = false;
    const publish = EntryCrud.writeEntry;
    t.mock.method(EntryCrud, "writeEntry", async (...args: Parameters<typeof publish>) => {
        if (args[0].pathname !== "doc.md" || args[1].channels.body?.content !== original) return publish(...args);
        materializing = true;
        started.resolve();
        try {
            await release.promise;
            return await publish(...args);
        } finally { materializing = false; }
    });
    const write = FilePublication.write;
    t.mock.method(FilePublication, "write", async (...args: Parameters<typeof write>) => {
        if (args[1] === fx.path) assert.equal(materializing, false, "file publication cannot overtake an acquired source projection");
        return write(...args);
    });
    const reconciling = MembershipMaterialization.materializeMember("doc.md", fx.root, fx.ctx, new Map());
    await started.promise;
    const committing = Promise.allSettled([fx.file.applyResolution({ attrs: proposal.attrs as never, metadata: null }, fx.ctx)]);
    try {
        assert.equal((await fx.file.applyResolution({ attrs: independent.attrs as never, metadata: null }, fx.ctx)).status, 200);
        assert.equal(await fs.readFile(fx.path, "utf8"), original);
        assert.equal(await fs.readFile(join(fx.root, "independent.md"), "utf8"), "independent\n");
    } finally { release.resolve(); }
    await reconciling;
    const [settled] = await committing;
    assert.equal(settled.status, "fulfilled");
    assert.equal(settled.value.status, 200);
    assert.equal(await fs.readFile(fx.path, "utf8"), "replacement\n");
    assert.equal((await fx.file.readEntry("doc.md", fx.ctx)).entry?.channels.body?.content, "replacement\n");
});

test("{§file-snapshot-revision}: staging cleanup failure preserves the original write error and leaves the target intact", async (t) => {
    const fx = await fixture(t);
    const baseline = (await FileSnapshot.acquire(fx.path, null))!.revision;
    const failure = new Error("fixture: stage I/O failed");
    const cleanupFailure = new Error("fixture: directory cleanup failed");
    const open = fs.open;
    t.mock.method(fs, "open", async (...args: Parameters<typeof open>) => {
        const handle = await open(...args);
        if (args[1] === "wx") t.mock.method(handle, "writeFile", async () => { throw failure; });
        return handle;
    });
    t.mock.method(fs, "rmdir", async () => { throw cleanupFailure; });
    const result = await FilePublication.write(fx.path, fx.path, baseline, Buffer.from("replacement\n"));
    assert.equal(result.status, "failed");
    if (result.status !== "failed") assert.fail("Expected the failed publication");
    assert.equal(result.published, false);
    assert.ok(result.cause instanceof AggregateError);
    assert.deepEqual(result.cause.errors, [failure, cleanupFailure]);
    assert.equal(await fs.readFile(fx.path, "utf8"), original);
    t.mock.restoreAll();
});

test("{§file-snapshot-revision}: a close failure preserves the original staging failure", async (t) => {
    const fx = await fixture(t);
    const baseline = (await FileSnapshot.acquire(fx.path, null))!.revision;
    const writeFailure = new Error("fixture: stage write failed");
    const closeFailure = new Error("fixture: close failed");
    const open = fs.open;
    t.mock.method(fs, "open", async (...args: Parameters<typeof open>) => {
        const handle = await open(...args);
        if (args[1] === "wx") {
            t.mock.method(handle, "writeFile", async () => { throw writeFailure; });
            const close = handle.close.bind(handle);
            t.mock.method(handle, "close", async () => { await close(); throw closeFailure; });
        }
        return handle;
    });
    const result = await FilePublication.write(fx.path, fx.path, baseline, Buffer.from("replacement\n"));
    assert.equal(result.status, "failed");
    if (result.status !== "failed") assert.fail("Expected the failed publication");
    assert.equal(result.published, false);
    assert.ok(result.cause instanceof SuppressedError);
    assert.equal(result.cause.suppressed, writeFailure);
    assert.equal(result.cause.error, closeFailure);
    assert.equal(await fs.readFile(fx.path, "utf8"), original);
    assert.deepEqual((await fs.readdir(fx.root)).filter((name) => name.startsWith(".plurnk-write-")), []);
});

test("{§file-snapshot-revision} {§derivation-dedup-parallel}: a slow projection never reserves its file and cannot publish over a newer edit", async (t) => {
    const release = Promise.withResolvers<void>();
    t.after(() => release.resolve());
    const fx = await fixture(t);
    const pathname = "image.png";
    const seedBytes = Buffer.from([0, 1, 2, 3]);
    const replacement = Buffer.from([0, 9, 8, 7]);
    const seed = await fx.file.writeEntry(pathname, {
        channels: { body: { content: "", bytes: seedBytes, mimetype: "image/png" } },
    }, fx.ctx);
    assert.equal((await fx.file.applyResolution({ attrs: seed.attrs as never, metadata: null }, fx.ctx)).status, 200);
    const proposal = await fx.file.writeEntry(pathname, {
        channels: { body: { content: "", bytes: replacement, mimetype: "image/png" } },
    }, fx.ctx);
    assert.equal(proposal.status, 202);
    const projecting = Promise.withResolvers<void>();
    const ctx = makeSchemeCtx({ ...fx.ctx, mimetypes: mimetypesFixture({
        projectReadable: async (input: { content: Uint8Array }) => {
            assert.deepEqual(input.content, seedBytes);
            projecting.resolve();
            await release.promise;
            return { content: "old derived body", sourceMimetype: "image/png", projectionIdentity: "fixture", facts: null };
        },
    }) });
    const materializing = MembershipMaterialization.materializeMember(pathname, fx.root, ctx, new Map());
    await projecting.promise;
    const result = await fx.file.applyResolution({ attrs: proposal.attrs as never, metadata: null }, fx.ctx);
    assert.equal(result.status, 200, "a file commit must progress while its old snapshot is being projected");
    assert.deepEqual(await fs.readFile(join(fx.root, pathname)), replacement);
    const committed = await fx.file.readEntry(pathname, fx.ctx);
    release.resolve();
    assert.equal(await materializing, null, "the stale derived body is discarded, not published");
    assert.deepEqual(await fx.file.readEntry(pathname, fx.ctx), committed);
});
});

describe("git-env-hermetic", () => {
// {§membership} — fixture and production Git spawns ignore a hostile
// launch environment, bind repository identity to cwd, and never consume global hooks.















const execFileP = promisify(execFile);
const git = (args: string[], cwd: string) => execFileP("git", args, { cwd, env: hermeticGitEnv() });
const seed = (cwd: string) => execFileP("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--no-verify", "-q", "-m", "seed"], { cwd, env: hermeticGitEnv() });

test("{§membership} demo fixture + production git spawns ignore a hook's absolute GIT_DIR — the victim worktree stays untouched", async () => {
    const base = await mkdtemp(join(tmpdir(), "plurnk-hermetic-"));
    const victim = join(base, "victim");
    const priorGitDir = process.env.GIT_DIR;
    const db = await openMigrated();
    try {
        // The victim: a primary repo + a linked worktree — the shape whose hook env poisons.
        await git(["init", "-q", victim], base);
        await git(["config", "user.email", "victim@plurnk.invalid"], victim);
        await git(["config", "user.name", "v"], victim);
        await writeFile(join(victim, "victim-file.md"), "precious\n");
        await git(["add", "victim-file.md"], victim);
        await seed(victim);
        await git(["worktree", "add", "-q", join(base, "lane"), "-b", "lane"], victim);
        const victimHead = (await git(["rev-parse", "HEAD"], join(base, "lane"))).stdout.trim();

        // The hostile env: exactly what git exports to a pre-push hook in a worktree.
        process.env.GIT_DIR = join(victim, ".git", "worktrees", "lane");

        // Fixture class: a sandbox init + seed commit must land in the SANDBOX.
        const sandbox = join(base, "sandbox");
        await mkdir(sandbox);
        await writeFile(join(sandbox, "tracked.md"), "# sandbox truth\n");
        initializeDemoRepository(sandbox, "seed");
        const sandboxLog = (await git(["log", "--oneline"], sandbox)).stdout;
        assert.match(sandboxLog, /seed/, "the sandbox owns its seed commit");

        const emptySandbox = join(base, "empty-sandbox");
        await mkdir(emptySandbox);
        initializeDemoRepository(emptySandbox, "empty seed", false);
        const emptyLog = (await git(["log", "--oneline"], emptySandbox)).stdout;
        assert.match(emptyLog, /empty seed/, "the empty-workspace fixture owns its seed commit");

        // Production class: membership resolution against the sandbox must read the SANDBOX.
        const workspaceId = await insertWorkspace(db, `hermetic-${crypto.randomUUID()}`);
        await rootWorkspace(db, workspaceId, sandbox);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1);
        const turnId = await insertTurn(db, loopId, 1, 102);
        const ctx: PlurnkSchemeContext = {
            db, workspaceId, sessionId, loopId, turnId,
            writer: "_plurnk", signal: undefined, mimetypes: DEFAULT_MIMETYPES,
            weigh: (t: string) => Math.ceil(t.length / 4),
        };
        await GitMembership.indexGitMembership(ctx);
        const member = await db.crud_find_workspace_entry.get<{ id: number }>({ workspace_id: workspaceId, scheme: "file", authority: "", pathname: "tracked.md" });
        assert.ok(member, "membership read the sandbox's ls-files, not the victim's");
        const leak = await db.crud_find_workspace_entry.get<{ id: number }>({ workspace_id: workspaceId, scheme: "file", authority: "", pathname: "victim-file.md" });
        assert.equal(leak, undefined, "no victim file leaked into membership");

        // The victim is pristine: same HEAD, clean tree, no seed stacked on the lane branch.
        const laneHead = (await git(["rev-parse", "HEAD"], join(base, "lane"))).stdout.trim();
        assert.equal(laneHead, victimHead, "no commit landed on the victim's lane branch");
        const status = (await git(["status", "--short"], join(base, "lane"))).stdout.trim();
        assert.equal(status, "", "the victim's working tree is untouched — no deleted tracked files");
    } finally {
        if (priorGitDir === undefined) delete process.env.GIT_DIR;
        else process.env.GIT_DIR = priorGitDir;
        await db.close();
        await rm(base, { recursive: true, force: true });
    }
});

test("{§membership} a spawn under hermeticGitEnv severs a hostile GLOBAL core.hooksPath — it never fires or escapes", async () => {
    const base = await mkdtemp(join(tmpdir(), "plurnk-hooksesc-"));
    const priorGlobal = process.env.GIT_CONFIG_GLOBAL;
    try {
        // A HOSTILE machine global config: core.hooksPath → a hook dir whose pre-commit fires a marker.
        // A real global core.hooksPath is the hostile machine-config vector under test.
        const evilHooks = join(base, "evil-hooks"); await mkdir(evilHooks);
        const marker = join(base, "PWNED");
        await writeFile(join(evilHooks, "pre-commit"), `#!/bin/sh\ntouch "${marker}"\n`); await chmod(join(evilHooks, "pre-commit"), 0o755);
        const hostileGlobal = join(base, "hostile-gitconfig");
        await writeFile(hostileGlobal, `[core]\n\thooksPath = ${evilHooks}\n`);
        process.env.GIT_CONFIG_GLOBAL = hostileGlobal; // the machine's global config is now hostile

        const commit = async (repo: string, env: NodeJS.ProcessEnv): Promise<void> => {
            await mkdir(repo, { recursive: true });
            const g = (args: string[]) => execFileP("git", args, { cwd: repo, env });
            await g(["init", "-q"]); await g(["config", "user.email", "fixture@plurnk.invalid"]); await g(["config", "user.name", "t"]);
            await writeFile(join(repo, "f.md"), "x"); await g(["add", "f.md"]);
            await g(["commit", "-q", "-m", "c"]); // NO --no-verify, NO -c hooksPath — a global hook WOULD fire if read
        };

        // CONTROL: a GIT_*-scrubbed env + the hostile global DOES fire the hook — proves the vector is
        // real, not a tautology. The scrub is essential and self-referential: raw process.env would
        // inherit a pre-push hook's absolute GIT_DIR (this test runs inside the drill) and the control
        // commit would escape into the worktree. Scrubbing GIT_*
        // (what hermeticGitEnv also does) confines the commit to its own repo while the hostile
        // GIT_CONFIG_GLOBAL still routes the hook.
        const scrubbedGit = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
        await commit(join(base, "raw"), { ...scrubbedGit, GIT_CONFIG_GLOBAL: hostileGlobal });
        assert.ok(existsSync(marker), "control: under the hostile global config, the hook fires");

        // THE FIX: the same commit under hermeticGitEnv (GIT_CONFIG_GLOBAL → /dev/null) does NOT read it.
        const marker2 = join(base, "PWNED2");
        await writeFile(join(evilHooks, "pre-commit"), `#!/bin/sh\ntouch "${marker2}"\n`); await chmod(join(evilHooks, "pre-commit"), 0o755);
        await commit(join(base, "hermetic"), hermeticGitEnv());
        assert.ok(!existsSync(marker2), "hermeticGitEnv severed the global config — the hostile hooksPath never fired");
    } finally {
        if (priorGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
        else process.env.GIT_CONFIG_GLOBAL = priorGlobal;
        await rm(base, { recursive: true, force: true });
    }
});

// #568 — a supplied repository's OWN config names a program (`core.fsmonitor`); automatic
// inspection (status, membership) must not run it as the daemon. Control first: the vector is real.
test("{§membership} automatic inspection never runs a repository-supplied core.fsmonitor helper — status and membership stay normal", async () => {
    const base = await mkdtemp(join(tmpdir(), "plurnk-fsmonitor-"));
    const repo = join(base, "supplied");
    const marker = join(base, "HELPER-RAN");
    const db = await openMigrated();
    const priorAllowed = process.env.PLURNK_SERVICE_GIT_ALLOWED;
    try {
        await mkdir(repo);
        await git(["init", "-q"], repo);
        await git(["config", "user.email", "s@plurnk.invalid"], repo);
        await git(["config", "user.name", "s"], repo);
        await writeFile(join(repo, "tracked.md"), "# tracked\n");
        await git(["add", "tracked.md"], repo);
        await seed(repo);
        // The hostile local config: a benign helper that leaves a marker OUTSIDE the repository and
        // then fails, which makes git fall back to a full scan (so status still answers).
        const helper = join(base, "fsmonitor-helper.sh");
        await writeFile(helper, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`);
        await chmod(helper, 0o755);
        await git(["config", "core.fsmonitor", helper], repo);
        await writeFile(join(repo, "tracked.md"), "# tracked\n\nedit\n");  // give refresh something to look at

        // CONTROL: a GIT_*-scrubbed env without the pin DOES run the repository's helper.
        const scrubbed = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
        await execFileP("git", ["status", "--porcelain=v1", "-z"], { cwd: repo, env: { ...scrubbed, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
        assert.ok(existsSync(marker), "control: without the pin, the supplied repository's fsmonitor helper runs");
        await rm(marker, { force: true });

        // PRODUCTION: GitState.status and membership indexing, both through hermeticGitEnv.
        const workspaceId = await insertWorkspace(db, `fsmonitor-${crypto.randomUUID()}`);
        await rootWorkspace(db, workspaceId, repo);
        process.env.PLURNK_SERVICE_GIT_ALLOWED = "1";
        const status = await GitState.status(db, workspaceId, undefined);
        assert.ok(status, "status still answers under the pinned configuration");
        assert.deepEqual(status.files.map((file) => file.path), ["tracked.md"], "ordinary status content is intact");
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1);
        const turnId = await insertTurn(db, loopId, 1, 102);
        const ctx: PlurnkSchemeContext = {
            db, workspaceId, sessionId, loopId, turnId,
            writer: "_plurnk", signal: undefined, mimetypes: DEFAULT_MIMETYPES,
            weigh: (t: string) => Math.ceil(t.length / 4),
        };
        await GitMembership.indexGitMembership(ctx);
        const member = await db.crud_find_workspace_entry.get<{ id: number }>({ workspace_id: workspaceId, scheme: "file", authority: "", pathname: "tracked.md" });
        assert.ok(member, "membership still indexes the tracked file");
        assert.ok(!existsSync(marker), "neither status nor membership ran the repository-supplied helper");
    } finally {
        if (priorAllowed === undefined) delete process.env.PLURNK_SERVICE_GIT_ALLOWED;
        else process.env.PLURNK_SERVICE_GIT_ALLOWED = priorAllowed;
        await db.close();
        await rm(base, { recursive: true, force: true });
    }
});

// {§membership} (#568 residual): no key can pin off an arbitrary `filter.<name>` driver,
// so a supplied repository declaring one is refused for automatic inspection — a warning-and-skip.
test("{§membership} automatic inspection refuses a supplied repository declaring a filter program — status and membership skip, one notice names the key", async () => {
    const base = await mkdtemp(join(tmpdir(), "plurnk-filter-"));
    const repo = join(base, "supplied");
    const marker = join(base, "FILTER-RAN");
    const db = await openMigrated();
    const priorAllowed = process.env.PLURNK_SERVICE_GIT_ALLOWED;
    const priorAuto = process.env.PLURNK_SERVICE_GIT_AUTO;
    try {
        await mkdir(repo);
        await git(["init", "-q"], repo);
        await git(["config", "user.email", "s@plurnk.invalid"], repo);
        await git(["config", "user.name", "s"], repo);
        await writeFile(join(repo, ".gitattributes"), "*.md filter=marker\n");
        await writeFile(join(repo, "tracked.md"), "# tracked\n");
        await git(["add", ".gitattributes", "tracked.md"], repo);
        await seed(repo);
        // The hostile local config: a clean driver that leaves a marker OUTSIDE the repository.
        const helper = join(base, "clean-helper.sh");
        await writeFile(helper, `#!/bin/sh\ntouch "${marker}"\ncat\n`);
        await chmod(helper, 0o755);
        await git(["config", "filter.marker.clean", helper], repo);
        await git(["config", "filter.marker.required", "true"], repo);

        // A touched mapped file: its stat data no longer matches the index, so the next status
        // refresh must re-hash it through the clean driver to decide whether it changed.
        await new Promise((resolve) => setTimeout(resolve, 1100));
        await writeFile(join(repo, "tracked.md"), "# touched\n");

        // CONTROL: the very status command production runs, under the pinned env, DOES run the driver.
        await execFileP("git", ["status", "--porcelain=v1", "-z", "--branch", "--untracked-files=all"], { cwd: repo, env: hermeticGitEnv() });
        assert.ok(existsSync(marker), "control: `git status` on the supplied repository runs its clean driver — no key pins it off");
        await rm(marker, { force: true });
        await new Promise((resolve) => setTimeout(resolve, 1100));
        await writeFile(join(repo, "tracked.md"), "# touched again\n");

        // PRODUCTION: automatic inspection through the shared boundary refuses the repository.
        const workspaceId = await insertWorkspace(db, `filter-${crypto.randomUUID()}`);
        await rootWorkspace(db, workspaceId, repo);
        process.env.PLURNK_SERVICE_GIT_ALLOWED = "1";
        process.env.PLURNK_SERVICE_GIT_AUTO = "1";
        assert.equal(await GitState.status(db, workspaceId, undefined), null, "status answers as for a non-repository");
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1);
        const turnId = await insertTurn(db, loopId, 1, 102);
        const notices: Array<Record<string, unknown>> = [];
        const ctx: PlurnkSchemeContext = {
            db, workspaceId, sessionId, loopId, turnId,
            writer: "_plurnk", signal: undefined, mimetypes: DEFAULT_MIMETYPES,
            weigh: (t: string) => Math.ceil(t.length / 4),
            pushNotice: (notice) => { notices.push(notice); },
        };
        await GitMembership.indexGitMembership(ctx);
        await GitMembership.indexGitMembership(ctx);
        const member = await db.crud_find_workspace_entry.get<{ id: number }>({ workspace_id: workspaceId, scheme: "file", authority: "", pathname: "tracked.md" });
        assert.equal(member, undefined, "no automatic membership from the refused repository");
        assert.ok(!existsSync(marker), "neither status nor membership ran the repository-supplied driver");
        assert.deepEqual(notices, [{
            source: "engine:membership",
            kind: "git_inspection_refused",
            level: "warn",
            message: "Automatic Git inspection is off for this repository: its config declares filter.marker.clean, a program git status could run. Git status and automatic Git membership are skipped; explicit git commands are unaffected.",
        }], "one notice names the key, announced once across passes");

        // CONTROL: an ordinary repository still indexes and answers status through the same boundary.
        const plain = join(base, "plain");
        await mkdir(plain);
        await git(["init", "-q"], plain);
        await git(["config", "user.email", "s@plurnk.invalid"], plain);
        await git(["config", "user.name", "s"], plain);
        await writeFile(join(plain, "ok.md"), "# ok\n");
        await git(["add", "ok.md"], plain);
        await seed(plain);
        const plainWorkspace = await insertWorkspace(db, `plain-${crypto.randomUUID()}`);
        await rootWorkspace(db, plainWorkspace, plain);
        assert.deepEqual((await GitState.status(db, plainWorkspace, undefined))?.branch !== undefined, true, "an ordinary repository still answers status");
        const plainSession = await insertSession(db, plainWorkspace);
        const plainLoop = await insertLoop(db, plainSession, 1);
        const plainTurn = await insertTurn(db, plainLoop, 1, 102);
        const plainNotices: unknown[] = [];
        await GitMembership.indexGitMembership({
            ...ctx, workspaceId: plainWorkspace, sessionId: plainSession, loopId: plainLoop, turnId: plainTurn,
            pushNotice: (notice) => { plainNotices.push(notice); },
        });
        const plainMember = await db.crud_find_workspace_entry.get<{ id: number }>({ workspace_id: plainWorkspace, scheme: "file", authority: "", pathname: "ok.md" });
        assert.ok(plainMember, "an ordinary repository still indexes its tracked file");
        assert.deepEqual(plainNotices, [], "no refusal notice for an ordinary repository");
    } finally {
        if (priorAllowed === undefined) delete process.env.PLURNK_SERVICE_GIT_ALLOWED;
        else process.env.PLURNK_SERVICE_GIT_ALLOWED = priorAllowed;
        if (priorAuto === undefined) delete process.env.PLURNK_SERVICE_GIT_AUTO;
        else process.env.PLURNK_SERVICE_GIT_AUTO = priorAuto;
        await db.close();
        await rm(base, { recursive: true, force: true });
    }
});

test("{§membership} {§executor-policy}: the daemon trusts the repository it was pointed at by path, and nothing wider", () => {
    const pins = (env: NodeJS.ProcessEnv): Record<string, string | undefined> => Object.fromEntries(Array.from({ length: Number(env.GIT_CONFIG_COUNT) },
        (_, index) => [env[`GIT_CONFIG_KEY_${index}`], env[`GIT_CONFIG_VALUE_${index}`]]));
    const kept = { "core.fsmonitor": "false", "core.hooksPath": "/dev/null", "core.excludesFile": excludesFile() };
    assert.deepEqual(pins(hermeticGitEnv()), kept, "the program pins and the user's excludes file, and no trust without a root");
    const trusted = hermeticGitEnv("/srv/work/repo");
    assert.deepEqual(pins(trusted), { ...kept, "safe.directory": "/srv/work/repo" }, "a root is trusted by its path alone");
    assert.equal(trusted.GIT_CONFIG_GLOBAL, "/dev/null");
    assert.equal(trusted.GIT_CONFIG_SYSTEM, "/dev/null");
});
});

describe("git-state", () => {
// SPEC {§packet-inject} — one Git snapshot supplies the compact packet
// summary and exact per-path state for causal filesystem observations. GitState shells
// `git status` (service-side, the same surface membership uses), gated by
// PLURNK_SERVICE_GIT_ALLOWED (the hard service ceiling) + a git worktree.













const execFileP = promisify(execFile);

test("{§packet-inject}: unborn and detached heads are not invented branch names", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-git-head-"));
    const db = await openMigrated();
    const orig = process.env.PLURNK_SERVICE_GIT_ALLOWED;
    const git = (...args: string[]) => execFileP("git", args, { cwd: root, env: hermeticGitEnv() });
    try {
        await git("init", "-q", "-b", "main");
        process.env.PLURNK_SERVICE_GIT_ALLOWED = "1";
        const workspaceId = await insertWorkspace(db, `git-head-${crypto.randomUUID()}`);
        await rootWorkspace(db, workspaceId, root);
        const unborn = await GitState.status(db, workspaceId, undefined);
        assert.equal(unborn?.branch, "main");
        assert.match(PacketWire.renderGit(unborn), /branch `main` \(no commits\)/);

        await git("-c", "user.name=fixture", "-c", "user.email=fixture@plurnk.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-q", "--allow-empty", "-m", "seed");
        assert.match(PacketWire.renderGit(await GitState.status(db, workspaceId, undefined)), /branch `main` —/);
        await git("checkout", "--detach", "-q");
        const detached = await GitState.status(db, workspaceId, undefined);
        assert.equal(detached?.branch, null);
        assert.match(PacketWire.renderGit(detached), /detached HEAD —/);
        assert.doesNotMatch(PacketWire.renderGit(detached), /branch/);
    } finally {
        if (orig === undefined) delete process.env.PLURNK_SERVICE_GIT_ALLOWED;
        else process.env.PLURNK_SERVICE_GIT_ALLOWED = orig;
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("{§membership} with no git binary on PATH there is no status and no automatic membership", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-git-absent-"));
    const empty = await mkdtemp(join(tmpdir(), "plurnk-no-path-"));
    const db = await openMigrated();
    const allowed = process.env.PLURNK_SERVICE_GIT_ALLOWED;
    const path = process.env.PATH;
    try {
        await execFileP("git", ["init", "-q", "-b", "main"], { cwd: root, env: hermeticGitEnv() });
        await writeFile(join(root, "tracked.md"), "# tracked\n");
        await execFileP("git", ["add", "tracked.md"], { cwd: root, env: hermeticGitEnv() });
        await execFileP("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--no-verify", "-q", "-m", "seed"], { cwd: root, env: hermeticGitEnv() });
        process.env.PLURNK_SERVICE_GIT_ALLOWED = "1";
        const workspaceId = await insertWorkspace(db, `git-absent-${crypto.randomUUID()}`);
        await rootWorkspace(db, workspaceId, root);

        process.env.PATH = empty;  // a real worktree the daemon cannot ask about
        assert.equal(await GitState.status(db, workspaceId, undefined), null, "no git binary, no status — never a reimplementation");
        await GitMembership.resolveGitMembership(db, workspaceId, undefined);
        const member = await db.crud_find_workspace_entry.get<{ id: number }>({
            workspace_id: workspaceId, scheme: "file", authority: "", pathname: "tracked.md",
        });
        assert.equal(member, undefined, "and no automatic membership is granted from a repository it cannot read");
    } finally {
        process.env.PATH = path;
        if (allowed === undefined) delete process.env.PLURNK_SERVICE_GIT_ALLOWED; else process.env.PLURNK_SERVICE_GIT_ALLOWED = allowed;
        await db.close();
        await rm(root, { recursive: true, force: true });
        await rm(empty, { recursive: true, force: true });
    }
});

test("{§operator-config-workspace-settings} GitState.status reads the working tree, gated by PLURNK_SERVICE_GIT_ALLOWED", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-gitstate-"));
    const db = await openMigrated();
    const orig = process.env.PLURNK_SERVICE_GIT_ALLOWED;
    try {
        await execFileP("git", ["init", "-q"], { cwd: root, env: hermeticGitEnv() });
        await execFileP("git", ["config", "user.email", "fixture@plurnk.invalid"], { cwd: root, env: hermeticGitEnv() });
        await execFileP("git", ["config", "user.name", "t"], { cwd: root, env: hermeticGitEnv() });
        await writeFile(join(root, "tracked.md"), "# tracked\n");
        await execFileP("git", ["add", "tracked.md"], { cwd: root, env: hermeticGitEnv() });
        await execFileP("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--no-verify", "-q", "-m", "seed"], { cwd: root, env: hermeticGitEnv() });
        await writeFile(join(root, "untracked.txt"), "loose\n");          // 1 untracked
        await writeFile(join(root, "tracked.md"), "# tracked\n\nedit\n");  // 1 unstaged
        await writeFile(join(root, "staged.txt"), "indexed\n");
        await execFileP("git", ["add", "staged.txt"], { cwd: root, env: hermeticGitEnv() });

        const workspaceId = await insertWorkspace(db, `gitstate-${crypto.randomUUID()}`);
        await rootWorkspace(db, workspaceId, root);

        process.env.PLURNK_SERVICE_GIT_ALLOWED = "1";
        const status = await GitState.status(db, workspaceId, undefined);
        assert.notEqual(status, null, "a worktree yields git state");
        assert.equal(status!.untracked, 1, "the loose file is counted untracked");
        assert.equal(status!.unstaged, 1, "the edited tracked file is counted unstaged");
        assert.equal(status!.staged, 1, "the indexed addition is counted staged");
        assert.ok(status!.branch !== null && status!.branch.length > 0, "a branch name is reported");
        assert.deepEqual(
            status!.files,
            [
                { path: "staged.txt", status: "A " },
                { path: "tracked.md", status: " M" },
                { path: "untracked.txt", status: "??", member: null },
            ],
            "per-path metadata preserves both porcelain coordinates instead of collapsing staged and unstaged M",
        );

        // The hard ceiling flatly disables it.
        process.env.PLURNK_SERVICE_GIT_ALLOWED = "0";
        assert.equal(await GitState.status(db, workspaceId, undefined), null, "PLURNK_SERVICE_GIT_ALLOWED=0 disables git status metadata");
    } finally {
        if (orig === undefined) delete process.env.PLURNK_SERVICE_GIT_ALLOWED;
        else process.env.PLURNK_SERVICE_GIT_ALLOWED = orig;
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("{§packet-inject}: tracking, renames, conflicts, and NUL-safe paths survive porcelain v2", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-git-paths-"));
    const db = await openMigrated();
    const orig = process.env.PLURNK_SERVICE_GIT_ALLOWED;
    const git = (...args: string[]) => execFileP("git", args, { cwd: root, env: hermeticGitEnv() });
    const commit = (message: string) => git("-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-q", "-am", message);
    try {
        await git("init", "-q", "-b", "main");
        await git("config", "user.email", "fixture@plurnk.invalid");
        await git("config", "user.name", "fixture");
        await mkdir(join(root, "sub"));
        await writeFile(join(root, "conflict.txt"), "base\n");
        await writeFile(join(root, "sub", "old  name\t.txt"), "rename me\n");
        await git("add", ".");
        await commit("seed");
        await git("checkout", "-q", "-b", "upstream");
        await writeFile(join(root, "conflict.txt"), "upstream\n");
        await commit("upstream change");
        await git("checkout", "-q", "main");
        await writeFile(join(root, "conflict.txt"), "local\n");
        await commit("local change");
        await git("branch", "--set-upstream-to=upstream");
        await git("mv", "sub/old  name\t.txt", "sub/new\nname.txt");
        await writeFile(join(root, "sub", "new\nname.txt"), "rename me\nmodified after staging\n");
        await writeFile(join(root, "sub", "  loose\nfile.txt"), "loose\n");
        const workspaceId = await insertWorkspace(db, `git-paths-${crypto.randomUUID()}`);
        await rootWorkspace(db, workspaceId, join(root, "sub"));
        process.env.PLURNK_SERVICE_GIT_ALLOWED = "1";
        const status = await GitState.status(db, workspaceId, undefined);
        assert.ok(status);
        assert.equal(status.branch, "main");
        assert.equal(status.ahead, 1);
        assert.equal(status.behind, 1);
        assert.equal(status.staged, 1, "a rename counts once, not once per path");
        assert.equal(status.unstaged, 1);
        assert.equal(status.untracked, 1);
        assert.deepEqual(status.files.toSorted((a, b) => a.path < b.path ? -1 : 1), [
            { path: "  loose\nfile.txt", status: "??", member: null },
            { path: "new\nname.txt", status: "RM" },
            { path: "old  name\t.txt", status: "RM" },
        ]);
        await git("add", "sub/new\nname.txt");
        await commit("rename");
        await assert.rejects(git("-c", "commit.gpgsign=false", "merge", "upstream"), { code: 1 });
        const conflicted = await GitState.status(db, workspaceId, undefined);
        assert.ok(conflicted?.files.some((file) => file.path === "../conflict.txt" && file.status === "UU"));
        assert.equal(conflicted?.staged, 1);
        assert.equal(conflicted?.unstaged, 1);
    } finally {
        if (orig === undefined) delete process.env.PLURNK_SERVICE_GIT_ALLOWED;
        else process.env.PLURNK_SERVICE_GIT_ALLOWED = orig;
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});
});

describe("instructions-exclusions", () => {
// {§membership} entry (3): the AGENTS.md standard admits instruction content from
// disk, but never past the operator's exclusions — an AGENTS.md the repository ignores, or a hide
// constraint matches, is not projected; a plain nested one still is (#400).











const execFileP = promisify(execFile);

test("{§tools-resource-materialization} an ignored or excluded AGENTS.md is never projected; the standard does not outrank .gitignore or an exclusion", async () => {
    const priorAllowed = process.env.PLURNK_SERVICE_GIT_ALLOWED;
    const priorAuto = process.env.PLURNK_SERVICE_GIT_AUTO;
    process.env.PLURNK_SERVICE_GIT_ALLOWED = "1";
    process.env.PLURNK_SERVICE_GIT_AUTO = "1";
    const priorMembers = process.env.PLURNK_MEMBERS_no_hidden;
    const priorEnabled = process.env.PLURNK_MEMBERS_ENABLED;
    process.env.PLURNK_MEMBERS_no_hidden = "!packages/hidden/**";   // an operator exclusion ({§tools-resource-materialization})
    process.env.PLURNK_MEMBERS_ENABLED = "1";
    const dir = await mkdtemp(join(tmpdir(), "plurnk-instructions-"));
    try {
        await execFileP("git", ["init", "-q"], { cwd: dir, env: hermeticGitEnv() });
        await writeFile(join(dir, ".gitignore"), "packages/secret/AGENTS.md\n/AGENTS.md\n", "utf8");
        await writeFile(join(dir, "AGENTS.md"), "# root — ignored by .gitignore\n", "utf8");
        for (const sub of ["web", "secret", "hidden"]) {
            await mkdir(join(dir, "packages", sub), { recursive: true });
            await writeFile(join(dir, "packages", sub, "AGENTS.md"), `# ${sub}\n`, "utf8");
        }
        const mock = new Mock({ contextWindow: 16384, responses: [makeMockResponse("````SEND [200]\ndone\n````", 50)] });
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                const workspaceId = ((await rpcCall(ws, 1, "workspace.create", { name: "instructions", projectRoot: dir })).result as { id: number }).id;
                const { loopId, finalStatus } = (await runLoopToTerminal(ws, 2, { prompt: "go" })) as { loopId: number; finalStatus: number };
                assert.equal(finalStatus, 200);
                const sessionId = (await db.test_get_session_id_by_loop.get<{ session_id: number }>({ loop_id: loopId }))!.session_id;
                const entry = (pathname: string) => db.crud_find_workspace_entry.get<{ id: number }>({
                    workspace_id: workspaceId, scheme: "file", authority: "", pathname,
                });
                assert.equal(await entry("AGENTS.md"), undefined, "a gitignored root AGENTS.md is not admitted");
                assert.equal(await entry("packages/secret/AGENTS.md"), undefined, "a gitignored nested AGENTS.md is not admitted");
                assert.equal(await entry("packages/hidden/AGENTS.md"), undefined, "an excluded nested AGENTS.md is not admitted");
                assert.ok(await entry("packages/web/AGENTS.md"), "an admitted nested AGENTS.md still is");
                const rows = await db.test_log_entries_by_session.all<{ op: string | null; pathname: string; status_rx: number }>({ session_id: sessionId });
                assert.equal(rows.some((r) => r.pathname === "AGENTS.md" && r.status_rx >= 400), false, "no turn-0 stunt fires for an excluded root AGENTS.md — nothing 404s");
            } finally { ws.close(); }
        });
    } finally {
        await rm(dir, { recursive: true, force: true });
        if (priorAllowed === undefined) delete process.env.PLURNK_SERVICE_GIT_ALLOWED;
        else process.env.PLURNK_SERVICE_GIT_ALLOWED = priorAllowed;
        if (priorAuto === undefined) delete process.env.PLURNK_SERVICE_GIT_AUTO;
        else process.env.PLURNK_SERVICE_GIT_AUTO = priorAuto;
        if (priorMembers === undefined) delete process.env.PLURNK_MEMBERS_no_hidden;
        else process.env.PLURNK_MEMBERS_no_hidden = priorMembers;
        if (priorEnabled === undefined) delete process.env.PLURNK_MEMBERS_ENABLED;
        else process.env.PLURNK_MEMBERS_ENABLED = priorEnabled;
    }
});
});
