// SPEC §14 architectural-decision contract tests.
//
//   §14.3-git-membership  — git-substrate workspace membership. git-tracked
//       files are members with no client `add`; active members are READable
//       through the file scheme. BUILT — the two tests below pass.
//
//   §14.3-constraint-overlay / §14.3-emi-divergence-signal  — the client
//       supersede (add/ignore/read-only) and the out-of-band divergence signal.
//       DEFERRED; the two red tests at the bottom are the deferral ledger,
//       EXPECTED TO FAIL until built. Do not weaken them to green.

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

// ───────────────────────────── §14.3 ─────────────────────────────
//
// git-substrate membership (§14.3-git-membership) is BUILT — these two pass.
// The two deferred reds (overlay, divergence signal) follow at the bottom.

// Set up a session whose project_root is a freshly `git init`'d repo holding
// one COMMITTED, git-tracked file that is NEVER added via
// crud_insert_session_entry. Per §14.3 D4 it should be a member by virtue of
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
        // (the session.set_root backend) so git-ls-files membership (SPEC §14.3
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
        };
        await fn(root, ctx, db, trackedPath);
    } finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
};

test("[§14.3-git-membership] git-tracked file (never client-added) is a workspace member via git ls-files", async () => {
    await withGitWorkspace(async (_root, ctx, db, trackedPath) => {
        // The file is committed in git but NO crud_insert_session_entry was
        // issued for it. Under §14.3 D4 (git present → ls-files membership),
        // it MUST register as a member of the session.
        const member = await (db.crud_find_session_entry as PrepMethod).get<{ id: number }>({
            session_id: ctx.sessionId, scheme: null, pathname: trackedPath,
        });
        assert.notEqual(
            member, undefined,
            "git-tracked file must be a session member via `git ls-files` (SPEC §14.3)",
        );

        // And the membership gate in File.read must therefore admit it (200),
        // not 404 it as a non-member.
        const result = await new File().read(readStmt(urlPath("file", trackedPath)), ctx);
        assert.equal(
            result.status, 200,
            "READ of a git-tracked member must succeed; 404 means git membership was not established",
        );
        assert.equal(result.content, "# Tracked by git\n\nThis file is a git member.\n");
    });
});

test("[§14.3-edit-membership-gate] EDIT of an existing non-member is refused — no read (leak), no overwrite (wipe)", async () => {
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

// ───────────── §14.3 deferred — `{ todo }` until built ─────────────
// The deferral ledger: each asserts the promised behaviour and is EXPECTED TO
// FAIL until the feature lands. Marked `{ todo }` (not hard-red): the assertion
// still RUNS — it's the coverage — and reports as a known not-yet-passing, not a
// false green; it FLIPS to a flagged passing-todo the day the feature lands. That
// keeps CI a live gate instead of red-forever noise. Don't weaken to a real pass.

test("[§14.3-constraint-overlay] client supersede (add/ignore/read-only) overrides git membership", { todo: "DEFERRED — flips when session_constraints CRUD is built (SPEC §14.3)" }, async () => {
    const db = await openMigrated();
    try {
        // DEFERRED (SPEC §14.3). The constraint overlay is the client's supersede
        // over git membership — add (members git misses), ignore (drop tracked
        // ones), read-only (member for read, writes rejected) — and the SOLE
        // membership source when there is no git (D4). No substrate exists yet;
        // assert its CRUD foundation, since there is no behavioural surface to
        // drive until it lands. Flips green when session_constraints is built.
        assert.notEqual(
            (db as unknown as Record<string, unknown>).crud_insert_session_constraint, undefined,
            "session_constraints CRUD must exist for the client-supersede overlay (SPEC §14.3) — DEFERRED/UNBUILT",
        );
    } finally { await db.close(); }
});

test("[§14.3-emi-divergence-signal] out-of-band change to a member emits a synthetic log entry", { todo: "DEFERRED — flips when the EMI divergence signal is built (SPEC §14.3)" }, async () => {
    await withGitWorkspace(async (root, ctx, db, trackedPath) => {
        // DEFERRED (SPEC §14.3). EMI re-reads disk (built), but emits no synthetic
        // log entry when a member diverges out-of-band, so the model never learns
        // it changed. Materialize the member, mutate it on disk behind the model's
        // back, run again, and assert the second turn's log carries a system-origin
        // signal naming the file. Red until the divergence signal is built.
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
        const signalled = packet.system.log.some((r) => r.origin === "system" && JSON.stringify(r).includes(trackedPath));
        assert.ok(
            signalled,
            "EMI must emit a synthetic log entry naming the out-of-band-changed member (SPEC §14.3) — DEFERRED/UNBUILT",
        );
    });
});
