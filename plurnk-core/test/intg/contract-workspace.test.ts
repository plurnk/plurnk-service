// SPEC §decisions architectural-decision contract tests.
//
//   The built core passes: git-substrate membership (§membership-git-membership), the
//   membership-bound edit (§membership-edit-membership-gate), the pick/hide/view overlay
//   (§membership-overlay-pick / -hide / -view), and the divergence signal
//   (§membership-emi-divergence-signal).

import test from "node:test";
import Owner from "../../src/core/Owner.ts";
import { hermeticGitEnv } from "../../src/core/git-env.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlurnkStatement, SendStatement, ReadStatement, EditStatement, LineMarker, ParsedPath, UrlPath } from "@plurnk/plurnk-contracts/grammar";
import { Mock } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import File from "../../src/schemes/File.ts";
import GitMembership from "../../src/core/git-membership.ts";
import type { Db } from "../../src/core/Db.ts";
import type { PlurnkSchemeContext } from "../../src/core/scheme-types.ts";
import {
    openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn,
    seedEnvelope, DEFAULT_MIMETYPES, logEntries, rootWorkspace,
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

const fullReplace: LineMarker = { marks: [1, -1] };
const editStmt = (target: ParsedPath | null, body: string, marker: LineMarker | null = null): EditStatement => ({
    op: "EDIT", suffix: "", signal: null, target,
    lineMarker: marker, body, position: { line: 1, column: 1 },
});

const mockResponse = (ops: PlurnkStatement[]) => ({
    assistant: { content: "", ops, reasoning: null },
});

// ───────────────────────────── §membership ─────────────────────────────
//
// git-substrate membership (§membership-git-membership) is BUILT — these two pass.
// The two deferred reds (overlay, divergence signal) follow at the bottom.

// Set up a workspace whose project_root is a freshly `git init`'d repo holding
// one COMMITTED, git-tracked file that is NEVER added via
// crud_insert_workspace_entry. Per §membership D4 it should be a member by virtue of
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
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const turnId = await insertTurn(db, loopId, 1, 102);
        const ctx: PlurnkSchemeContext = {
            db, workspaceId, workerId, loopId, turnId,
            writer: "model", signal: undefined, mimetypes: DEFAULT_MIMETYPES,
            tokenize: (t: string) => Math.ceil(t.length / 4),
        };
        await fn(root, ctx, db, trackedPath);
    } finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
};

test("an untracked-but-not-ignored file is a member the moment it exists; .gitignore still filters", async () => {
    await withGitWorkspace(async (root, ctx, db) => {
        // A model-created file: on disk, untracked, never `git add`ed.
        await writeFile(join(root, "draft.md"), "# A model-created draft\n");
        // .gitignore (itself untracked) excludes secret.env — git honors it even uncommitted.
        await writeFile(join(root, ".gitignore"), "secret.env\n");
        await writeFile(join(root, "secret.env"), "TOKEN=xxx\n");

        await GitMembership.indexGitMembership(ctx);
        const member = async (pathname: string) => db.crud_find_workspace_entry.get<{ id: number }>({ workspace_id: ctx.workspaceId, owner_id: await Owner.commonsId(db, ctx.workspaceId), scheme: "file", pathname });

        assert.ok(await member("draft.md"), "the untracked-but-not-ignored file is a member the moment it exists (no git-stage)");
        assert.equal(await member("secret.env"), undefined, ".gitignore still filters — an ignored file is never a member");

        // Removing it → the next sync un-registers it (reconciled like any git member, not stranded).
        await rm(join(root, "draft.md"));
        await GitMembership.indexGitMembership(ctx);
        assert.equal(await member("draft.md"), undefined, "deleting the file un-registers its membership (reconciled)");
    });
});

test("git-tracked file (never client-added) is a workspace member via git ls-files", async () => {
    await withGitWorkspace(async (_root, ctx, db, trackedPath) => {
        // The file is committed in git but NO crud_insert_workspace_entry was
        // issued for it. Under §membership D4 (git present → ls-files membership),
        // it MUST register as a member of the workspace.
        const member = await db.crud_find_workspace_entry.get<{ id: number }>({
            workspace_id: ctx.workspaceId, owner_id: await Owner.commonsId(db, ctx.workspaceId), scheme: "file", pathname: `${trackedPath}`,
        });
        assert.notEqual(
            member, undefined,
            "git-tracked file must be a workspace member via `git ls-files` (SPEC §membership)",
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

test("EDIT of an existing non-member is refused — no read (leak), no overwrite (wipe)", async () => {
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
        const member = await new File().edit(editStmt(urlPath("file", `/${trackedPath}`), "# Tracked by git\n\nrevised.\n", fullReplace), ctx);
        assert.equal(member.status, 202, "EDIT of a git-tracked member must still propose (202)");
        const created = await new File().edit(editStmt(urlPath("file", "/new-note.md"), "fresh content\n"), ctx);
        assert.equal(created.status, 202, "EDIT of a new (non-existent) path must still propose creation (202)");
    });
});

test("a host-absolute spelling names its literal jail path — READ 404s, EDIT proposes a nested CREATE, never a fold", async () => {
    await withGitWorkspace(async (root, ctx, _db, trackedPath) => {
        await GitMembership.indexGitMembership(ctx); // materialize the tracked member
        const abs = `${root}/${trackedPath}`; // the path an exec/build tool would print

        // {§fs-namespace} — chroot semantics: host paths do not exist in the jail. The spelling
        // canonicalizes to the nested bare key abs.slice(1) (a legitimate, empty in-jail path),
        // NOT to the member — the old exec-echo fold was existence-dependent resolution (run59).
        const read = await new File().read(readStmt(urlPath("file", abs)), ctx);
        assert.equal(read.status, 404, "a host-absolute spelling is not the member's name — no fold, deterministic 404");

        // The write side obeys the same law: the spelling names an EMPTY in-jail path, so EDIT
        // lawfully proposes an exclusive CREATE there ({§fs-namei} — names mean what they mean),
        // nesting under root rather than silently editing the member.
        const edit = await new File().edit(editStmt(urlPath("file", abs), "# Tracked by git\n\nrevised.\n"), ctx);
        assert.equal(edit.status, 202, "EDIT proposes at the literal jail path");
        assert.equal((edit.attrs as { path: string }).path, abs.slice(1), "the proposal targets the nested bare canon key, never the member");
    });
});

type WriteAttrs = { path: string; canonical: string; patched: string; baseSig: string | null };

test("an out-of-band disk change between propose and accept is a write conflict, never a clobber", async () => {
    await withGitWorkspace(async (root, ctx, _db, trackedPath) => {
        await GitMembership.indexGitMembership(ctx); // snapshot: body channel + synced_sig, both from disk
        const file = new File();

        // The model proposes an edit against the snapshot it READ.
        const proposal = await file.edit(editStmt(urlPath("file", `/${trackedPath}`), "# Tracked by git\n\nthe model's revision.\n", fullReplace), ctx);
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

test("with no drift the proposal lands and restamps the snapshot signature", async () => {
    await withGitWorkspace(async (root, ctx, db, trackedPath) => {
        await GitMembership.indexGitMembership(ctx);
        const file = new File();
        const sigBefore = await db.crud_get_member_sig.get<{ synced_sig: string | null }>({ workspace_id: ctx.workspaceId, owner_id: await Owner.commonsId(db, ctx.workspaceId), scheme: "file", pathname: `${trackedPath}` });

        const revised = "# Tracked by git\n\nlanded cleanly.\n";
        const proposal = await file.edit(editStmt(urlPath("file", `/${trackedPath}`), revised, fullReplace), ctx);
        assert.equal(proposal.status, 202);

        const applied = await file.applyResolution({ attrs: proposal.attrs as WriteAttrs }, ctx);
        assert.equal(applied.status, 200, "no drift → the write lands");
        assert.equal(await readFile(join(root, trackedPath), "utf8"), revised, "disk holds the proposed content");

        // synced_sig is restamped to the landed write, so the next reconcile doesn't narrate our
        // own write back at the model as an FsDivergence.
        const sigAfter = await db.crud_get_member_sig.get<{ synced_sig: string | null }>({ workspace_id: ctx.workspaceId, owner_id: await Owner.commonsId(db, ctx.workspaceId), scheme: "file", pathname: `${trackedPath}` });
        assert.notEqual(sigAfter?.synced_sig, sigBefore?.synced_sig, "synced_sig advanced to the landed write");
        assert.notEqual(sigAfter?.synced_sig, null, "synced_sig is stamped, not cleared");
    });
});

test("resolveMembershipEffects tags each file member / view / hidden", async () => {
    await withGitWorkspace(async (root, ctx, db, trackedPath) => {
        // Two more tracked files so we can view one and hide one.
        await writeFile(join(root, "readme.md"), "# readme\n");
        await writeFile(join(root, "secret.md"), "secret\n");
        await execFileP("git", ["add", "readme.md", "secret.md"], { cwd: root, env: hermeticGitEnv() });
        await execFileP("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--no-verify", "-q", "-m", "more"], { cwd: root, env: hermeticGitEnv() });
        // view readme.md (read-only member); hide secret.md (excluded from membership).
        await db.crud_insert_workspace_constraint.run({ workspace_id: ctx.workspaceId, effect: "view", glob: "readme.md" });
        await db.crud_insert_workspace_constraint.run({ workspace_id: ctx.workspaceId, effect: "hide", glob: "secret.md" });

        const { members, hidden } = await GitMembership.resolveMembershipEffects(db, ctx.workspaceId, undefined);
        const effectOf = (path: string) => members.find((m) => m.path === path)?.effect;
        assert.equal(effectOf(trackedPath), "member", "a plain tracked file resolves as a writable member");
        assert.equal(effectOf("readme.md"), "view", "a view-constrained member resolves read-only (view)");
        assert.ok(!members.some((m) => m.path === "secret.md"), "a hidden file is not in members");
        assert.ok(hidden.includes("secret.md"), "a hide-constrained tracked file resolves as hidden — the same (ls-files ∪ pick) − hide the manifest uses");
    });
});

test("membership is the workspace's — one overlay, identical for every worker", async () => {
    await withGitWorkspace(async (_root, ctx, db, trackedPath) => {
        // ctx.workerId is run A. Spin a SECOND run on the same workspace.
        const workerB = await insertWorker(db, ctx.workspaceId);
        assert.notEqual(ctx.workerId, workerB, "two distinct runs on one workspace");

        // The overlay is keyed by SESSION, never run: resolveMembershipEffects and crud_find_workspace_entry
        // both take workspace_id ONLY (membership lives on workspace_constraints.workspace_id / entries.workspace_id —
        // there is no worker_id anywhere in it). So both workers resolve the IDENTICAL member set; there is no
        // per-worker overlay to diverge. Divergent membership is a different workspace (§machine-processes).
        const { members } = await GitMembership.resolveMembershipEffects(db, ctx.workspaceId, undefined);
        assert.ok(members.some((m) => m.path === trackedPath && m.effect === "member"), "the git-tracked file is a member of the workspace (not of a worker)");
        const entry = await db.crud_find_workspace_entry.get<{ id: number }>({ workspace_id: ctx.workspaceId, owner_id: await Owner.commonsId(db, ctx.workspaceId), scheme: "file", pathname: `${trackedPath}` });
        assert.ok(entry, "the member entry is workspace-scoped — run A and run B see the identical row (one filesystem)");
    });
});

// ───────────── §membership deferred — `{ todo }` until built ─────────────
// The deferral ledger: each asserts the promised behaviour and is EXPECTED TO
// FAIL until the feature lands. Marked `{ todo }` (not hard-red): the assertion
// still RUNS — it's the coverage — and reports as a known not-yet-passing, not a
// false green; it FLIPS to a flagged passing-todo the day the feature lands. That
// keeps CI a live gate instead of red-forever noise. Don't weaken to a real pass.

test("a hide-glob drops a tracked file from membership, reconciling already-registered ones", async () => {
    await withGitWorkspace(async (_root, ctx, db, trackedPath) => {
        // trackedPath is already a git member (withGitWorkspace established it).
        const before = await db.crud_find_workspace_entry.get<{ id: number }>({ workspace_id: ctx.workspaceId, owner_id: await Owner.commonsId(db, ctx.workspaceId), scheme: "file", pathname: `${trackedPath}`});
        assert.notEqual(before, undefined, "precondition: the tracked file is a member");

        // Client ignores it; membership re-resolves.
        await db.crud_insert_workspace_constraint.run({ workspace_id: ctx.workspaceId, effect: "hide", glob: trackedPath });
        await GitMembership.resolveGitMembership(db, ctx.workspaceId, undefined);

        // Reconciled: the entry is GONE (un-registered), not merely hidden — entries == members.
        const after = await db.crud_find_workspace_entry.get<{ id: number }>({ workspace_id: ctx.workspaceId, owner_id: await Owner.commonsId(db, ctx.workspaceId), scheme: "file", pathname: `${trackedPath}`});
        assert.equal(after, undefined, "an ignored member must be un-registered (rummy's removed-file case)");
        const read = await new File().read(readStmt(urlPath("file", `/${trackedPath}`)), ctx);
        assert.equal(read.status, 404, "an ignored file is not readable — it left the curated surface");
    });
});

test("a pick-glob admits an untracked file git misses", async () => {
    await withGitWorkspace(async (root, ctx, db) => {
        // untracked.md is NOT in git; an add-glob admits it as a member via the scan.
        await writeFile(join(root, "untracked.md"), "# git misses me\n");
        await db.crud_insert_workspace_constraint.run({ workspace_id: ctx.workspaceId, effect: "pick", glob: "*.md" });
        await GitMembership.indexGitMembership(ctx);  // resolve membership + materialize (production's per-turn pass)
        const member = await db.crud_find_workspace_entry.get<{ id: number }>({ workspace_id: ctx.workspaceId, owner_id: await Owner.commonsId(db, ctx.workspaceId), scheme: "file", pathname: "untracked.md" });
        assert.notEqual(member, undefined, "an add-glob admits an untracked match as a member");
        // And it's readable — admitted to the curated surface.
        const read = await new File().read(readStmt(urlPath("file", "/untracked.md")), ctx);
        assert.equal(read.status, 200, "an added file is readable");
    });
});

test("a view-glob keeps a member readable but refuses edits", async () => {
    await withGitWorkspace(async (_root, ctx, db, trackedPath) => {
        await db.crud_insert_workspace_constraint.run({ workspace_id: ctx.workspaceId, effect: "view", glob: trackedPath });
        await GitMembership.indexGitMembership(ctx);  // materialize the member (read-only gates edits, not membership)
        // READ still works — it's a member...
        const read = await new File().read(readStmt(urlPath("file", `/${trackedPath}`)), ctx);
        assert.equal(read.status, 200, "a read-only member stays readable");
        // ...but EDIT is refused at the membership check, before any diff.
        const edit = await new File().edit(editStmt(urlPath("file", `/${trackedPath}`), "changed\n"), ctx);
        assert.equal(edit.status, 403, "a read-only member refuses edits");
    });
});

test("out-of-band change to a member surfaces as a system delta-EDIT", async () => {
    await withGitWorkspace(async (root, ctx, db, trackedPath) => {
        // EMI re-reads disk each turn (git materialization); the build-time delta
        // detector turns an out-of-band member change into a system EDIT naming the
        // file (source="file"). Turn 1 first-sights it (silent); mutate it on disk
        // behind the model's back; turn 2 must carry the signal.
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({
            contextWindow: 100000,
            responses: [mockResponse([sendStmt(200)]), mockResponse([sendStmt(200)])],
        });

        await engine.runTurn({ provider, workspaceId: ctx.workspaceId, workerId: ctx.workerId, loopId: ctx.loopId, messages: [] });

        await writeFile(join(root, trackedPath), "# Tracked by git\n\nEDITED OUT OF BAND.\n");

        const t2 = await engine.runTurn({ provider, workspaceId: ctx.workspaceId, workerId: ctx.workerId, loopId: ctx.loopId, messages: [] });
        const row = await db.test_get_packet.get<{ packet: string }>({ id: t2.turnId });
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

test("a member unchanged on disk is not re-tokenized on the next pass", async () => {
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

test("overlapping startup and turn membership requests coalesce into one workspace pass", async () => {
    await withGitWorkspace(async (_root, ctx, db, trackedPath) => {
        let calls = 0;
        const slow: PlurnkSchemeContext = {
            ...ctx,
            tokenize: (text: string) => {
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
            owner_id: await Owner.commonsId(db, ctx.workspaceId),
            scheme: "file",
            pathname: trackedPath,
        });
        assert.ok(entry !== undefined);
        const channels = await db.crud_read_channels.all<{ name: string }>({ entry_id: entry.id });
        assert.deepEqual(channels.map((row) => row.name), ["body"]);
        assert.equal(calls, 1, "both callers share one materialization pass instead of queueing a redundant forest scan");
    });
});

test("PLURNK_SERVICE_GIT_ALLOWED=0 denies all git membership, un-re-enableable", async () => {
    await withGitWorkspace(async (_root, ctx, db, trackedPath) => {
        const prev = process.env.PLURNK_SERVICE_GIT_ALLOWED;
        process.env.PLURNK_SERVICE_GIT_ALLOWED = "0";
        try {
            await GitMembership.resolveGitMembership(db, ctx.workspaceId, undefined);
            const member = await db.crud_find_workspace_entry.get<{ id: number }>({ workspace_id: ctx.workspaceId, owner_id: await Owner.commonsId(db, ctx.workspaceId), scheme: "file", pathname: `${trackedPath}`});
            assert.equal(member, undefined, "ALLOWED=0 must deny git membership — no member resolves");
        } finally {
            if (prev === undefined) delete process.env.PLURNK_SERVICE_GIT_ALLOWED; else process.env.PLURNK_SERVICE_GIT_ALLOWED = prev;
        }
    });
});

test("NUL-headed content is a binary marker regardless of the extension's lying label", async () => {
    // #320 — extension detection fell through to the markdown default for .wasm and a
    // 3.3MB blob entered the corpus as prose. The sniff reads bytes, not labels: a .md
    // file whose head carries NUL materializes as the empty octet-stream marker (READ-415
    // class), never as text — no FTS row, no tokens, no embedding.
    await withGitWorkspace(async (root, ctx, db) => {
        const evil = "blob.md"; // the most trusted-looking extension
        await writeFile(join(root, evil), Buffer.concat([Buffer.from("MZ"), Buffer.alloc(64, 0), Buffer.from("binary tail")]));
        await execFileP("git", ["add", evil], { cwd: root, env: hermeticGitEnv() });
        await GitMembership.indexGitMembership(ctx);
        const row = await db.ops_read_channel.get<{ content: string; mimetype: string }>({
            workspace_id: ctx.workspaceId, owner_id: await Owner.commonsId(db, ctx.workspaceId), scheme: "file", pathname: `${evil}`, channel: "body",
        });
        assert.ok(row !== undefined, "the member materialized");
        assert.equal(row.mimetype, "application/octet-stream", "the sniff overrode the label");
        assert.equal(row.content, "", "binary bodies are empty markers");
        const fts = await db.semantic_rank_candidates_fts.all<{ key: string }>({
            fts_query: "binary OR tail",
            candidates: "[]",
            k: 5,
        });
        assert.deepEqual(fts, [], "no keyword ghost of the blob");
    });
});
