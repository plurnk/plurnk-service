// SPEC §decisions architectural-decision contract tests.
//
//   ALL of §membership is BUILT — the tests below pass: git-substrate membership
//   (§membership-git-membership), the membership-bound edit (§membership-edit-membership-gate),
//   the full constraint overlay (§membership-constraint-ignore / -readonly / -add), and
//   the out-of-band divergence signal (§membership-emi-divergence-signal). No §membership
//   deferrals remain.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlurnkStatement, SendStatement, ReadStatement, EditStatement, ParsedPath, UrlPath } from "@plurnk/plurnk-grammar";
import { Mock } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import File from "../../src/schemes/File.ts";
import GitMembership from "../../src/core/git-membership.ts";
import Envelope from "../../src/server/envelope.ts";
import type { Db, PrepMethod } from "../../src/core/Db.ts";
import type { PlurnkSchemeContext } from "../../src/core/scheme-types.ts";
import {
    openMigrated, insertSession, insertRun, insertLoop, insertTurn,
    seedEnvelope, DEFAULT_MIMETYPES,
} from "./_helpers.ts";

const execFileP = promisify(execFile);

const sendStmt = (status: number): SendStatement => ({
    op: "SEND", suffix: "", signal: status, target: null,
    lineMarker: null, body: { raw: "", json: null },
    position: { line: 1, column: 1 },
});

const urlPath = (scheme: string, pathname: string): UrlPath => ({
    kind: "url", raw: `${scheme}://${pathname}`, scheme,
    username: null, password: null, hostname: null, port: null,
    pathname, params: {}, fragment: null,
});

const readStmt = (target: ParsedPath | null): ReadStatement => ({
    op: "READ", suffix: "", signal: null, target,
    lineMarker: null, body: null, position: { line: 1, column: 1 },
});

const editStmt = (target: ParsedPath | null, body: string): EditStatement => ({
    op: "EDIT", suffix: "", signal: null, target,
    lineMarker: null, body, position: { line: 1, column: 1 },
});

const mockResponse = (ops: PlurnkStatement[]) => ({
    assistant: { content: "", ops, reasoning: null },
});

// ───────────────────────────── §membership ─────────────────────────────
//
// git-substrate membership (§membership-git-membership) is BUILT — these two pass.
// The two deferred reds (overlay, divergence signal) follow at the bottom.

// Set up a session whose project_root is a freshly `git init`'d repo holding
// one COMMITTED, git-tracked file that is NEVER added via
// crud_insert_session_entry. Per §membership D4 it should be a member by virtue of
// `git ls-files`.
const withGitWorkspace = async (
    fn: (root: string, ctx: PlurnkSchemeContext, db: Db, trackedPath: string) => Promise<void>,
): Promise<void> => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-git-"));
    const db = await openMigrated();
    try {
        await execFileP("git", ["init", "-q"], { cwd: root });
        await execFileP("git", ["config", "user.email", "t@t.t"], { cwd: root });
        await execFileP("git", ["config", "user.name", "t"], { cwd: root });
        const trackedPath = "tracked.md";
        await writeFile(join(root, trackedPath), "# Tracked by git\n\nThis file is a git member.\n");
        await execFileP("git", ["add", trackedPath], { cwd: root });
        // --no-verify + isolated config: the test repo must not inherit the
        // outer project's commit-msg hooks (commitlint) or signing config —
        // this commit is fixture setup, not a project commit.
        await execFileP("git", [
            "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null",
            "commit", "--no-verify", "-q", "-m", "seed",
        ], { cwd: root });

        const sessionId = await insertSession(db, `git-ws-${crypto.randomUUID()}`);
        // Set the workspace pointer through the production session-root setter
        // (the session.set_root backend) so git-ls-files membership (SPEC §membership
        // D4) is established at workspace setup — exactly what a real client's
        // session.create({projectRoot}) / set_root does. This is the workspace
        // identity assignment (D1); a raw UPDATE here would skip it.
        await Envelope.updateSessionProjectRoot(db, sessionId, root);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1);
        const turnId = await insertTurn(db, loopId, 1, 102);
        const ctx: PlurnkSchemeContext = {
            db, sessionId, runId, loopId, turnId,
            writer: "model", signal: undefined, mimetypes: DEFAULT_MIMETYPES,
            tokenize: (t: string) => Math.ceil(t.length / 4),
        };
        await fn(root, ctx, db, trackedPath);
    } finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
};

test("[§membership-git-membership] git-tracked file (never client-added) is a workspace member via git ls-files", async () => {
    await withGitWorkspace(async (_root, ctx, db, trackedPath) => {
        // The file is committed in git but NO crud_insert_session_entry was
        // issued for it. Under §membership D4 (git present → ls-files membership),
        // it MUST register as a member of the session.
        const member = await (db.crud_find_session_entry as PrepMethod).get<{ id: number }>({
            session_id: ctx.sessionId, scheme: null, pathname: trackedPath,
        });
        assert.notEqual(
            member, undefined,
            "git-tracked file must be a session member via `git ls-files` (SPEC §membership)",
        );

        // And the membership gate in File.read must therefore admit it (200),
        // not 404 it as a non-member. Production materializes members every turn
        // (indexGitMembership at runTurn); do the same before the entry-backed read.
        await GitMembership.indexGitMembership(ctx);
        const result = await new File().read(readStmt(urlPath("file", trackedPath)), ctx);
        assert.equal(
            result.status, 200,
            "READ of a git-tracked member must succeed; 404 means git membership was not established",
        );
        assert.equal(result.content, "# Tracked by git\n\nThis file is a git member.\n");
    });
});

test("[§membership-edit-membership-gate] EDIT of an existing non-member is refused — no read (leak), no overwrite (wipe)", async () => {
    await withGitWorkspace(async (root, ctx, _db, trackedPath) => {
        // A gitignored/untracked secret on disk: it EXISTS but is never a member
        // (not in `git ls-files`, never client-added), so the model can't see it.
        const SECRET = "API_KEY=sk-do-not-leak\n";
        await writeFile(join(root, ".env"), SECRET);

        // EDIT it (as if blindly creating a config). Forbidden BEFORE any read:
        // 403, no secret anywhere in the result, file untouched on disk.
        const blocked = await new File().edit(editStmt(urlPath("file", ".env"), "PWNED=1\n"), ctx);
        assert.equal(blocked.status, 403, "EDIT of an existing non-member must be forbidden");
        assert.ok(!JSON.stringify(blocked).includes("sk-do-not-leak"), "the refused EDIT must not read the non-member's content into its result (no leak)");
        assert.equal(await readFile(join(root, ".env"), "utf8"), SECRET, "the non-member file must not be overwritten (no wiping a file the model can't see)");

        // The gate must not break legitimate edits: a tracked member still
        // proposes (202), and a new path still proposes creation (202 — creation
        // is how the model adds to its manifest).
        const member = await new File().edit(editStmt(urlPath("file", trackedPath), "# Tracked by git\n\nrevised.\n"), ctx);
        assert.equal(member.status, 202, "EDIT of a git-tracked member must still propose (202)");
        const created = await new File().edit(editStmt(urlPath("file", "new-note.md"), "fresh content\n"), ctx);
        assert.equal(created.status, 202, "EDIT of a new (non-existent) path must still propose creation (202)");
    });
});

// ───────────── §membership deferred — `{ todo }` until built ─────────────
// The deferral ledger: each asserts the promised behaviour and is EXPECTED TO
// FAIL until the feature lands. Marked `{ todo }` (not hard-red): the assertion
// still RUNS — it's the coverage — and reports as a known not-yet-passing, not a
// false green; it FLIPS to a flagged passing-todo the day the feature lands. That
// keeps CI a live gate instead of red-forever noise. Don't weaken to a real pass.

test("[§membership-constraint-ignore] an ignore-glob drops a tracked file from membership, reconciling already-registered ones", async () => {
    await withGitWorkspace(async (_root, ctx, db, trackedPath) => {
        // trackedPath is already a git member (withGitWorkspace established it).
        const before = await (db.crud_find_session_entry as PrepMethod).get<{ id: number }>({ session_id: ctx.sessionId, scheme: null, pathname: trackedPath });
        assert.notEqual(before, undefined, "precondition: the tracked file is a member");

        // Client ignores it; membership re-resolves.
        await (db.crud_insert_session_constraint as PrepMethod).run({ session_id: ctx.sessionId, effect: "ignore", glob: trackedPath });
        await GitMembership.resolveGitMembership(db, ctx.sessionId, undefined);

        // Reconciled: the entry is GONE (un-registered), not merely hidden — entries == members.
        const after = await (db.crud_find_session_entry as PrepMethod).get<{ id: number }>({ session_id: ctx.sessionId, scheme: null, pathname: trackedPath });
        assert.equal(after, undefined, "an ignored member must be un-registered (rummy's removed-file case)");
        const read = await new File().read(readStmt(urlPath("file", trackedPath)), ctx);
        assert.equal(read.status, 404, "an ignored file is not readable — it left the curated surface");
    });
});

test("[§membership-constraint-add] an add-glob admits an untracked file git misses", async () => {
    await withGitWorkspace(async (root, ctx, db) => {
        // untracked.md is NOT in git; an add-glob admits it as a member via the scan.
        await writeFile(join(root, "untracked.md"), "# git misses me\n");
        await (db.crud_insert_session_constraint as PrepMethod).run({ session_id: ctx.sessionId, effect: "add", glob: "*.md" });
        await GitMembership.indexGitMembership(ctx);  // resolve membership + materialize (production's per-turn pass)
        const member = await (db.crud_find_session_entry as PrepMethod).get<{ id: number }>({ session_id: ctx.sessionId, scheme: null, pathname: "untracked.md" });
        assert.notEqual(member, undefined, "an add-glob admits an untracked match as a member");
        // And it's readable — admitted to the curated surface.
        const read = await new File().read(readStmt(urlPath("file", "untracked.md")), ctx);
        assert.equal(read.status, 200, "an added file is readable");
    });
});

test("[§membership-constraint-readonly] a read-only-glob keeps a member readable but refuses edits", async () => {
    await withGitWorkspace(async (_root, ctx, db, trackedPath) => {
        await (db.crud_insert_session_constraint as PrepMethod).run({ session_id: ctx.sessionId, effect: "read-only", glob: trackedPath });
        await GitMembership.indexGitMembership(ctx);  // materialize the member (read-only gates edits, not membership)
        // READ still works — it's a member...
        const read = await new File().read(readStmt(urlPath("file", trackedPath)), ctx);
        assert.equal(read.status, 200, "a read-only member stays readable");
        // ...but EDIT is refused at the membership check, before any diff.
        const edit = await new File().edit(editStmt(urlPath("file", trackedPath), "changed\n"), ctx);
        assert.equal(edit.status, 403, "a read-only member refuses edits");
    });
});

test("[§membership-emi-divergence-signal] out-of-band change to a member surfaces as a system delta-EDIT", async () => {
    await withGitWorkspace(async (root, ctx, db, trackedPath) => {
        // EMI re-reads disk each turn (git materialization); the build-time delta
        // detector turns an out-of-band member change into a system EDIT naming the
        // file (source="file"). Turn 1 first-sights it (silent); mutate it on disk
        // behind the model's back; turn 2 must carry the signal.
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({
            contextSize: 100000,
            responses: [mockResponse([sendStmt(200)]), mockResponse([sendStmt(200)])],
        });

        await engine.runTurn({ provider, sessionId: ctx.sessionId, runId: ctx.runId, loopId: ctx.loopId, messages: [] });

        await writeFile(join(root, trackedPath), "# Tracked by git\n\nEDITED OUT OF BAND.\n");

        const t2 = await engine.runTurn({ provider, sessionId: ctx.sessionId, runId: ctx.runId, loopId: ctx.loopId, messages: [] });
        const row = await (db.test_get_packet as PrepMethod).get<{ packet: string }>({ id: t2.turnId });
        if (row === undefined) throw new Error("turn packet not found");
        const packet = JSON.parse(row.packet) as { system: { log: Array<{ origin?: string }> } };
        const signalled = packet.system.log.some((r) => r.origin === "plurnk" && JSON.stringify(r).includes(trackedPath));
        assert.ok(signalled, "EMI must surface the out-of-band-changed member as a system signal naming the file");
    });
});
