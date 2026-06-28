// SPEC §decisions architectural-decision contract tests.
//
//   The built core passes: git-substrate membership (§membership-git-membership), the
//   membership-bound edit (§membership-edit-membership-gate), the pick/hide/view overlay
//   (§membership-overlay-pick / -hide / -view), and the divergence signal
//   (§membership-emi-divergence-signal). The forest, the repo verb, change-gated sync,
//   and the git flags are the deferral ledger at the foot of this section.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
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
    seedEnvelope, DEFAULT_MIMETYPES, logEntries,
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

test("[§membership-auto-add] an untracked-but-not-ignored file is a member the moment it exists; .gitignore still filters", async () => {
    await withGitWorkspace(async (root, ctx, db) => {
        // A model-created file: on disk, untracked, never `git add`ed.
        await writeFile(join(root, "draft.md"), "# A model-created draft\n");
        // .gitignore (itself untracked) excludes secret.env — git honors it even uncommitted.
        await writeFile(join(root, ".gitignore"), "secret.env\n");
        await writeFile(join(root, "secret.env"), "TOKEN=xxx\n");

        await GitMembership.indexGitMembership(ctx);
        const member = (pathname: string) => (db.crud_find_session_entry as PrepMethod).get<{ id: number }>({ session_id: ctx.sessionId, scheme: null, pathname });

        assert.ok(await member("/draft.md"), "the untracked-but-not-ignored file is a member the moment it exists (no git-stage)");
        assert.equal(await member("/secret.env"), undefined, ".gitignore still filters — an ignored file is never a member");

        // Removing it → the next sync un-registers it (reconciled like any git member, not stranded).
        await rm(join(root, "draft.md"));
        await GitMembership.indexGitMembership(ctx);
        assert.equal(await member("/draft.md"), undefined, "deleting the file un-registers its membership (reconciled)");
    });
});

test("[§membership-git-membership] git-tracked file (never client-added) is a workspace member via git ls-files", async () => {
    await withGitWorkspace(async (_root, ctx, db, trackedPath) => {
        // The file is committed in git but NO crud_insert_session_entry was
        // issued for it. Under §membership D4 (git present → ls-files membership),
        // it MUST register as a member of the session.
        const member = await (db.crud_find_session_entry as PrepMethod).get<{ id: number }>({
            session_id: ctx.sessionId, scheme: null, pathname: `/${trackedPath}`,
        });
        assert.notEqual(
            member, undefined,
            "git-tracked file must be a session member via `git ls-files` (SPEC §membership)",
        );

        // And the membership gate in File.read must therefore admit it (200),
        // not 404 it as a non-member. Production materializes members every turn
        // (indexGitMembership at runTurn); do the same before the entry-backed read.
        await GitMembership.indexGitMembership(ctx);
        const result = await new File().read(readStmt(urlPath("file", `/${trackedPath}`)), ctx);
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
        const blocked = await new File().edit(editStmt(urlPath("file", "/.env"), "PWNED=1\n"), ctx);
        assert.equal(blocked.status, 403, "EDIT of an existing non-member must be forbidden");
        assert.ok(!JSON.stringify(blocked).includes("sk-do-not-leak"), "the refused EDIT must not read the non-member's content into its result (no leak)");
        assert.equal(await readFile(join(root, ".env"), "utf8"), SECRET, "the non-member file must not be overwritten (no wiping a file the model can't see)");

        // The gate must not break legitimate edits: a tracked member still
        // proposes (202), and a new path still proposes creation (202 — creation
        // is how the model adds to its manifest).
        const member = await new File().edit(editStmt(urlPath("file", `/${trackedPath}`), "# Tracked by git\n\nrevised.\n"), ctx);
        assert.equal(member.status, 202, "EDIT of a git-tracked member must still propose (202)");
        const created = await new File().edit(editStmt(urlPath("file", "/new-note.md"), "fresh content\n"), ctx);
        assert.equal(created.status, 202, "EDIT of a new (non-existent) path must still propose creation (202)");
    });
});

test("a member addressed by its ABSOLUTE disk path (echoed from exec/build output) normalizes to the relative key", async () => {
    await withGitWorkspace(async (root, ctx, _db, trackedPath) => {
        await GitMembership.indexGitMembership(ctx); // materialize the tracked member
        const abs = `${root}/${trackedPath}`; // the path an exec/build tool would print

        // READ by absolute path → resolves to the member (normalized to /tracked.md), not the
        // 404 the raw lookup gives (its stored key is /tracked.md, not the absolute form).
        const read = await new File().read(readStmt(urlPath("file", abs)), ctx);
        assert.equal(read.status, 200, "a member read by its absolute disk path resolves (normalized), not 404");
        assert.equal(read.content, "# Tracked by git\n\nThis file is a git member.\n");

        // EDIT by absolute path → proposes against the member's REAL file, not a wrong CREATE
        // at root/<absolute> nested under the root (which the un-normalized join would produce).
        const edit = await new File().edit(editStmt(urlPath("file", abs), "# Tracked by git\n\nrevised.\n"), ctx);
        assert.equal(edit.status, 202, "EDIT by absolute disk path proposes (202)");
        assert.equal((edit.attrs as { canonical: string }).canonical, join(root, trackedPath), "EDIT resolves to the member's real file, not a path nested under root");
    });
});

type WriteAttrs = { path: string; canonical: string; patched: string; baseSig: string | null };

test("[§membership-edit-write-cas] an out-of-band disk change between propose and accept is a write conflict, never a clobber", async () => {
    await withGitWorkspace(async (root, ctx, _db, trackedPath) => {
        await GitMembership.indexGitMembership(ctx); // snapshot: body channel + synced_sig, both from disk
        const file = new File();

        // The model proposes an edit against the snapshot it READ.
        const proposal = await file.edit(editStmt(urlPath("file", `/${trackedPath}`), "# Tracked by git\n\nthe model's revision.\n"), ctx);
        assert.equal(proposal.status, 202, "edit proposes (202)");

        // An ambient writer (the user's editor, a build step, a sibling run) changes the file on
        // disk AFTER the proposal was computed — exactly the drift the CAS must catch.
        const ambient = "# Tracked by git\n\nAMBIENT out-of-band change — written under the paused proposal, clearly a different size.\n";
        await writeFile(join(root, trackedPath), ambient, "utf8");

        // Accept. body omitted, so a successful write would land attrs.patched (the full proposed
        // content) — which is exactly what must NOT happen now that disk has drifted from baseSig.
        const applied = await file.applyResolution({ attrs: proposal.attrs as WriteAttrs }, ctx);
        assert.equal(applied.status, 409, "a drifted disk is a write conflict, not a silent clobber");
        assert.match(applied.outcome ?? "", /write_conflict/, "the conflict surfaces to the model as a write_conflict outcome");

        // The ambient change SURVIVES untouched — nothing got clever, nothing clobbered.
        assert.equal(await readFile(join(root, trackedPath), "utf8"), ambient, "the ambient out-of-band change is preserved, not overwritten by the stale proposal");
    });
});

test("[§membership-edit-write-cas] with no drift the proposal lands and restamps the snapshot signature", async () => {
    await withGitWorkspace(async (root, ctx, db, trackedPath) => {
        await GitMembership.indexGitMembership(ctx);
        const file = new File();
        const sigBefore = await (db.crud_get_member_sig as PrepMethod).get<{ synced_sig: string | null }>({ session_id: ctx.sessionId, scheme: null, pathname: `/${trackedPath}` });

        const revised = "# Tracked by git\n\nlanded cleanly.\n";
        const proposal = await file.edit(editStmt(urlPath("file", `/${trackedPath}`), revised), ctx);
        assert.equal(proposal.status, 202);

        const applied = await file.applyResolution({ attrs: proposal.attrs as WriteAttrs }, ctx);
        assert.equal(applied.status, 200, "no drift → the write lands");
        assert.equal(await readFile(join(root, trackedPath), "utf8"), revised, "disk holds the proposed content");

        // synced_sig is restamped to the landed write, so the next reconcile doesn't narrate our
        // own write back at the model as an FsDivergence.
        const sigAfter = await (db.crud_get_member_sig as PrepMethod).get<{ synced_sig: string | null }>({ session_id: ctx.sessionId, scheme: null, pathname: `/${trackedPath}` });
        assert.notEqual(sigAfter?.synced_sig, sigBefore?.synced_sig, "synced_sig advanced to the landed write");
        assert.notEqual(sigAfter?.synced_sig, null, "synced_sig is stamped, not cleared");
    });
});

test("[§membership-resolved-effects] resolveMembershipEffects tags each file member / view / hidden", async () => {
    await withGitWorkspace(async (root, ctx, db, trackedPath) => {
        // Two more tracked files so we can view one and hide one.
        await writeFile(join(root, "readme.md"), "# readme\n");
        await writeFile(join(root, "secret.md"), "secret\n");
        await execFileP("git", ["add", "readme.md", "secret.md"], { cwd: root });
        await execFileP("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--no-verify", "-q", "-m", "more"], { cwd: root });
        // view readme.md (read-only member); hide secret.md (excluded from membership).
        await (db.crud_insert_session_constraint as PrepMethod).run({ session_id: ctx.sessionId, effect: "view", glob: "readme.md" });
        await (db.crud_insert_session_constraint as PrepMethod).run({ session_id: ctx.sessionId, effect: "hide", glob: "secret.md" });

        const { members, hidden } = await GitMembership.resolveMembershipEffects(db, ctx.sessionId, undefined);
        const effectOf = (path: string) => members.find((m) => m.path === path)?.effect;
        assert.equal(effectOf(`/${trackedPath}`), "member", "a plain tracked file resolves as a writable member");
        assert.equal(effectOf("/readme.md"), "view", "a view-constrained member resolves read-only (view)");
        assert.ok(!members.some((m) => m.path === "/secret.md"), "a hidden file is not in members");
        assert.ok(hidden.includes("/secret.md"), "a hide-constrained tracked file resolves as hidden — the same (ls-files ∪ pick) − hide the manifest uses");
    });
});

test("[§machine-processes-one-overlay] membership is the session's — one overlay, identical for every run", async () => {
    await withGitWorkspace(async (_root, ctx, db, trackedPath) => {
        // ctx.runId is run A. Spin a SECOND run on the same session.
        const runB = await insertRun(db, ctx.sessionId);
        assert.notEqual(ctx.runId, runB, "two distinct runs on one session");

        // The overlay is keyed by SESSION, never run: resolveMembershipEffects and crud_find_session_entry
        // both take session_id ONLY (membership lives on session_constraints.session_id / entries.session_id —
        // there is no run_id anywhere in it). So both runs resolve the IDENTICAL member set; there is no
        // per-run overlay to diverge. Divergent membership is a different session (§machine-processes).
        const { members } = await GitMembership.resolveMembershipEffects(db, ctx.sessionId, undefined);
        assert.ok(members.some((m) => m.path === `/${trackedPath}` && m.effect === "member"), "the git-tracked file is a member of the session (not of a run)");
        const entry = await (db.crud_find_session_entry as PrepMethod).get<{ id: number }>({ session_id: ctx.sessionId, scheme: null, pathname: `/${trackedPath}` });
        assert.ok(entry, "the member entry is session-scoped — run A and run B see the identical row (one filesystem)");
    });
});

// ───────────── §membership deferred — `{ todo }` until built ─────────────
// The deferral ledger: each asserts the promised behaviour and is EXPECTED TO
// FAIL until the feature lands. Marked `{ todo }` (not hard-red): the assertion
// still RUNS — it's the coverage — and reports as a known not-yet-passing, not a
// false green; it FLIPS to a flagged passing-todo the day the feature lands. That
// keeps CI a live gate instead of red-forever noise. Don't weaken to a real pass.

test("[§membership-overlay-hide] a hide-glob drops a tracked file from membership, reconciling already-registered ones", async () => {
    await withGitWorkspace(async (_root, ctx, db, trackedPath) => {
        // trackedPath is already a git member (withGitWorkspace established it).
        const before = await (db.crud_find_session_entry as PrepMethod).get<{ id: number }>({ session_id: ctx.sessionId, scheme: null, pathname: `/${trackedPath}`});
        assert.notEqual(before, undefined, "precondition: the tracked file is a member");

        // Client ignores it; membership re-resolves.
        await (db.crud_insert_session_constraint as PrepMethod).run({ session_id: ctx.sessionId, effect: "hide", glob: trackedPath });
        await GitMembership.resolveGitMembership(db, ctx.sessionId, undefined);

        // Reconciled: the entry is GONE (un-registered), not merely hidden — entries == members.
        const after = await (db.crud_find_session_entry as PrepMethod).get<{ id: number }>({ session_id: ctx.sessionId, scheme: null, pathname: `/${trackedPath}`});
        assert.equal(after, undefined, "an ignored member must be un-registered (rummy's removed-file case)");
        const read = await new File().read(readStmt(urlPath("file", `/${trackedPath}`)), ctx);
        assert.equal(read.status, 404, "an ignored file is not readable — it left the curated surface");
    });
});

test("[§membership-overlay-pick] a pick-glob admits an untracked file git misses", async () => {
    await withGitWorkspace(async (root, ctx, db) => {
        // untracked.md is NOT in git; an add-glob admits it as a member via the scan.
        await writeFile(join(root, "untracked.md"), "# git misses me\n");
        await (db.crud_insert_session_constraint as PrepMethod).run({ session_id: ctx.sessionId, effect: "pick", glob: "*.md" });
        await GitMembership.indexGitMembership(ctx);  // resolve membership + materialize (production's per-turn pass)
        const member = await (db.crud_find_session_entry as PrepMethod).get<{ id: number }>({ session_id: ctx.sessionId, scheme: null, pathname: "/untracked.md" });
        assert.notEqual(member, undefined, "an add-glob admits an untracked match as a member");
        // And it's readable — admitted to the curated surface.
        const read = await new File().read(readStmt(urlPath("file", "/untracked.md")), ctx);
        assert.equal(read.status, 200, "an added file is readable");
    });
});

test("[§membership-overlay-view] a view-glob keeps a member readable but refuses edits", async () => {
    await withGitWorkspace(async (_root, ctx, db, trackedPath) => {
        await (db.crud_insert_session_constraint as PrepMethod).run({ session_id: ctx.sessionId, effect: "view", glob: trackedPath });
        await GitMembership.indexGitMembership(ctx);  // materialize the member (read-only gates edits, not membership)
        // READ still works — it's a member...
        const read = await new File().read(readStmt(urlPath("file", `/${trackedPath}`)), ctx);
        assert.equal(read.status, 200, "a read-only member stays readable");
        // ...but EDIT is refused at the membership check, before any diff.
        const edit = await new File().edit(editStmt(urlPath("file", `/${trackedPath}`), "changed\n"), ctx);
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
        const log = logEntries(JSON.parse(row.packet));
        const signalled = log.some((r) => r.origin === "plurnk" && JSON.stringify(r).includes(trackedPath));
        assert.ok(signalled, "EMI must surface the out-of-band-changed member as a system signal naming the file");
    });
});

// ─────────────── §membership deferral ledger (the new contract) ───────────────
//
// Each asserts a promised-but-unbuilt behavior and is EXPECTED TO FAIL until the
// feature lands — `{ todo }`, so the assertion RUNS (the coverage) and reports a
// known not-yet-passing, never a false green. Don't weaken to a real pass.

// A session rooted at a NON-git parent holding `repos` (each {dir, file} a committed
// one-file git repo). Mirrors withGitWorkspace's session wiring.
const seedForest = async (db: Db, repos: Array<{ dir: string; file: string }>): Promise<{ parent: string; ctx: PlurnkSchemeContext }> => {
    const parent = await mkdtemp(join(tmpdir(), "plurnk-forest-"));
    for (const { dir, file } of repos) {
        const r = join(parent, dir);
        await mkdir(r, { recursive: true });
        await execFileP("git", ["init", "-q"], { cwd: r });
        await execFileP("git", ["config", "user.email", "t@t.t"], { cwd: r });
        await execFileP("git", ["config", "user.name", "t"], { cwd: r });
        await writeFile(join(r, file), "# member\n");
        await execFileP("git", ["add", file], { cwd: r });
        await execFileP("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--no-verify", "-q", "-m", "seed"], { cwd: r });
    }
    const sessionId = await insertSession(db, `forest-${crypto.randomUUID()}`);
    await Envelope.updateSessionProjectRoot(db, sessionId, parent);
    const runId = await insertRun(db, sessionId);
    const loopId = await insertLoop(db, runId, 1);
    const turnId = await insertTurn(db, loopId, 1, 102);
    const ctx: PlurnkSchemeContext = {
        db, sessionId, runId, loopId, turnId,
        writer: "model", signal: undefined, mimetypes: DEFAULT_MIMETYPES,
        tokenize: (t: string) => Math.ceil(t.length / 4),
    };
    return { parent, ctx };
};

test("[§membership-forest] membership unions a session's declared repos under a non-git root", async () => {
    const db = await openMigrated();
    try {
        const { parent, ctx } = await seedForest(db, [{ dir: "alpha", file: "a.md" }, { dir: "beta", file: "b.md" }]);
        try {
            await (db.crud_insert_session_constraint as PrepMethod).run({ session_id: ctx.sessionId, effect: "repo", glob: join(parent, "alpha") });
            await (db.crud_insert_session_constraint as PrepMethod).run({ session_id: ctx.sessionId, effect: "repo", glob: join(parent, "beta") });
            await GitMembership.resolveGitMembership(db, ctx.sessionId, undefined);
            const a = await (db.crud_find_session_entry as PrepMethod).get<{ id: number }>({ session_id: ctx.sessionId, scheme: null, pathname: "/alpha/a.md" });
            const b = await (db.crud_find_session_entry as PrepMethod).get<{ id: number }>({ session_id: ctx.sessionId, scheme: null, pathname: "/beta/b.md" });
            assert.notEqual(a, undefined, "the first declared repo contributes its ls-files, path-prefixed");
            assert.notEqual(b, undefined, "the second declared repo contributes too — membership is their union");
        } finally { await rm(parent, { recursive: true, force: true }); }
    } finally { await db.close(); }
});

test("[§membership-overlay-repo] a `repo` declaration admits that repo's ls-files as members", async () => {
    const db = await openMigrated();
    try {
        const { parent, ctx } = await seedForest(db, [{ dir: "lib", file: "x.md" }]);
        try {
            await (db.crud_insert_session_constraint as PrepMethod).run({ session_id: ctx.sessionId, effect: "repo", glob: join(parent, "lib") });
            await GitMembership.resolveGitMembership(db, ctx.sessionId, undefined);
            const member = await (db.crud_find_session_entry as PrepMethod).get<{ id: number }>({ session_id: ctx.sessionId, scheme: null, pathname: "/lib/x.md" });
            assert.notEqual(member, undefined, "a repo declaration admits the repo's tracked files");
        } finally { await rm(parent, { recursive: true, force: true }); }
    } finally { await db.close(); }
});

test("a `repo` declared OUTSIDE the project root manifests at a relative (..) address whose content resolves to disk", async () => {
    const db = await openMigrated();
    const external = await mkdtemp(join(tmpdir(), "plurnk-ext-"));
    try {
        const { parent, ctx } = await seedForest(db, []); // a bare non-git project home
        try {
            // A git repo entirely outside the project home (a sibling temp dir).
            await execFileP("git", ["init", "-q"], { cwd: external });
            await execFileP("git", ["config", "user.email", "t@t.t"], { cwd: external });
            await execFileP("git", ["config", "user.name", "t"], { cwd: external });
            await writeFile(join(external, "ext.md"), "# external repo, outside the home\n");
            await execFileP("git", ["add", "ext.md"], { cwd: external });
            await execFileP("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--no-verify", "-q", "-m", "seed"], { cwd: external });

            await (db.crud_insert_session_constraint as PrepMethod).run({ session_id: ctx.sessionId, effect: "repo", glob: external });
            await GitMembership.indexGitMembership(ctx); // registers AND materializes (an absolute key would never materialize)

            // The member is addressed RELATIVE to the project root — a `..`-prefix, never absolute.
            const pathname = `/${join(relative(parent, external), "ext.md")}`;
            assert.match(pathname, /^\/\.\.\//, "the outside-root member's address is a relative ..-path, not absolute");
            const entry = await (db.crud_find_session_entry as PrepMethod).get<{ id: number }>({ session_id: ctx.sessionId, scheme: null, pathname });
            assert.notEqual(entry, undefined, "the outside-root member registers at its relative address");
            // The decisive check the absolute version never made: its CONTENT materialized — proof
            // join(project_root, "../..") resolved to the real disk file (an absolute key would nest under root).
            const body = await (db.ops_read_channel as PrepMethod).get<{ content: string }>({ session_id: ctx.sessionId, scheme: null, pathname, channel: "body" });
            assert.match(body?.content ?? "", /external repo/, "the outside-root member's content materialized — the relative address resolved to its real disk file");
        } finally { await rm(parent, { recursive: true, force: true }); }
    } finally { await rm(external, { recursive: true, force: true }); await db.close(); }
});

test("[§membership-overlay-repo] a `repo *` glob declares every immediate child repo, skipping non-git dirs", async () => {
    const db = await openMigrated();
    try {
        const { parent, ctx } = await seedForest(db, [{ dir: "alpha", file: "a.md" }, { dir: "beta", file: "b.md" }]);
        try {
            // A plain (non-git) sibling the `*` glob also matches — #repoToplevel must drop it.
            await mkdir(join(parent, "notrepo"), { recursive: true });
            await writeFile(join(parent, "notrepo", "loose.md"), "# not a repo\n");

            await (db.crud_insert_session_constraint as PrepMethod).run({ session_id: ctx.sessionId, effect: "repo", glob: "*" });
            await GitMembership.resolveGitMembership(db, ctx.sessionId, undefined);

            const a = await (db.crud_find_session_entry as PrepMethod).get<{ id: number }>({ session_id: ctx.sessionId, scheme: null, pathname: "/alpha/a.md" });
            const b = await (db.crud_find_session_entry as PrepMethod).get<{ id: number }>({ session_id: ctx.sessionId, scheme: null, pathname: "/beta/b.md" });
            const loose = await (db.crud_find_session_entry as PrepMethod).get<{ id: number }>({ session_id: ctx.sessionId, scheme: null, pathname: "/notrepo/loose.md" });
            assert.notEqual(a, undefined, "`repo *` expands to the first immediate child repo");
            assert.notEqual(b, undefined, "`repo *` expands to the second immediate child repo — every child unioned from one glob");
            assert.equal(loose, undefined, "a non-git child the glob matched is skipped — #repoToplevel drops it");
        } finally { await rm(parent, { recursive: true, force: true }); }
    } finally { await db.close(); }
});

test("[§membership-change-gated-sync] a member unchanged on disk is not re-tokenized on the next pass", async () => {
    await withGitWorkspace(async (_root, ctx) => {
        let calls = 0;
        const counting: PlurnkSchemeContext = { ...ctx, tokenize: (t: string) => { calls += 1; return Math.ceil(t.length / 4); } };
        await GitMembership.indexGitMembership(counting);
        const afterFirst = calls;
        assert.ok(afterFirst > 0, "precondition: the first sync tokenizes the member");
        await GitMembership.indexGitMembership(counting);
        assert.equal(calls, afterFirst, "an unchanged member must not be re-tokenized on the second pass — work is proportional to change");
    });
});

test("[§membership-git-flags] PLURNK_GIT_ALLOWED=0 denies all git membership, un-re-enableable", async () => {
    await withGitWorkspace(async (_root, ctx, db, trackedPath) => {
        const prev = process.env.PLURNK_GIT_ALLOWED;
        process.env.PLURNK_GIT_ALLOWED = "0";
        try {
            await GitMembership.resolveGitMembership(db, ctx.sessionId, undefined);
            const member = await (db.crud_find_session_entry as PrepMethod).get<{ id: number }>({ session_id: ctx.sessionId, scheme: null, pathname: `/${trackedPath}`});
            assert.equal(member, undefined, "ALLOWED=0 must deny git membership — no member resolves");
        } finally {
            if (prev === undefined) delete process.env.PLURNK_GIT_ALLOWED; else process.env.PLURNK_GIT_ALLOWED = prev;
        }
    });
});
