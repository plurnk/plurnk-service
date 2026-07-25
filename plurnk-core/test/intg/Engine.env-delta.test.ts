// SPEC §env-delta / §machine-processes — the environment delta as a PULL from the
// shared log. No per-worker snapshot: every edit is already a span-carrying log row, so
// at pre-turn a worker surfaces other actors' edits on shared entries since its OWN last
// turn, folded. Two producers: real cross-worker edits (a sibling's EDIT) and the
// filesystem-as-the-plurnk-run fs-sync fictions (source=file) for ambient disk drift.

import test from "node:test";
import { hermeticGitEnv } from "../../src/core/git-env.ts";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Engine from "../../src/core/Engine.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { Mock } from "@plurnk/plurnk-providers";
import type { MockResponse } from "@plurnk/plurnk-providers";
import type { SendStatement, EditStatement, UrlPath } from "@plurnk/plurnk-grammar";
import type { Db, PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn, rootWorkspace } from "./_helpers.ts";

const execFileP = promisify(execFile);

const okSend = (): MockResponse => ({
    assistant: {
        content: "",
        ops: [{ op: "SEND", suffix: "", signal: 200, target: null, lineMarker: null, body: { raw: "ok", json: null }, position: { line: 1, column: 1 } } as SendStatement],
        reasoning: null, usage: { prompt: 0, completion: 0, reasoning: 0, cached: 0, total: 0 },
    },
});
const MESSAGES = [{ role: "system" as const, content: "You are an agent." }, { role: "user" as const, content: "go" }];

// #507 — the envelope rides the provider; the wide Mock windows in this file keep the grinder out.
const makeEngine = (db: Db): Engine => new Engine({ db, schemes: new SchemeRegistry() });

const urlPath = (scheme: string, pathname: string): UrlPath => ({
    kind: "url", raw: `${scheme}://${pathname}`, scheme,
    username: null, password: null, hostname: null, port: null,
    pathname, params: {}, fragment: null,
});
const editStmt = (target: UrlPath, body: string): EditStatement => ({
    op: "EDIT", suffix: "", signal: null, target, lineMarker: null, body,
    position: { line: 1, column: 1 },
});

test("a worker learns a sibling's edit through its own log — pulled from the shared log, no per-worker snapshot", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `xrun-${crypto.randomUUID()}`);
        const workerA = await insertWorker(db, workspaceId);            // the model's run
        const loopA = await insertLoop(db, workerA, 1, "go");
        const workerB = await insertWorker(db, workspaceId);            // a sibling run on the same world
        const loopB = await insertLoop(db, workerB, 1);
        const turnB = await insertTurn(db, loopB, 1);
        const eng = makeEngine(db);
        const provider = new Mock({ contextWindow: 4096, responses: [okSend(), okSend()] });

        // A's turn 1 sets its "last looked" boundary; nothing happened before it, so no deltas.
        await eng.runTurn({ provider, workspaceId, workerId: workerA, loopId: loopA, messages: MESSAGES, turnNumber: 1 });
        await sleep(2);  // ms-resolution timestamps — ensure B's edit lands strictly after A's turn 1

        // B edits a shared entry — a real EDIT row in B's own log.
        const edit = await eng.dispatch({ statement: editStmt(urlPath("worker", "/shared.md"), "from sibling B"), workspaceId, workerId: workerB, loopId: loopB, turnId: turnB, sequence: 1, origin: "model" });
        assert.ok(edit.status === 200 || edit.status === 201, "B's edit to the shared entry lands");

        // A's turn 2 pulls B's edit from the shared log as a FOLDED delta — A consulted no
        // per-worker snapshot; it learned its world moved purely through its own log.
        await eng.runTurn({ provider, workspaceId, workerId: workerA, loopId: loopA, messages: MESSAGES, turnNumber: 2 });
        const rows = await (db.engine_render_log as PrepMethod).all<{ scheme: string | null; origin: string; op: string; pathname: string; source: string | null; expanded: number }>({ worker_id: workerA });
        const delta = rows.find((r) => r.op === "EDIT" && r.origin === "plurnk" && r.scheme === "worker" && r.pathname === "/shared.md");
        assert.ok(delta, "A's turn-2 log carries a delta for B's edit");
        assert.equal(delta!.source, String(workerB), "the delta is attributed to the sibling run that caused it");
        assert.equal(delta!.expanded, 0, "the broadcast delta lands FOLDED — listed, collapsed until the model OPENs it");
    } finally {
        await db.close();
    }
});

test("exactly two cross-worker channels — state via the env-delta, a message via inject", async () => {
    // Both doors in one place. (Was a stale `unbuilt` todo stub — the voice door IS built: inject,
    // and irc through it, resume parked runs in place, #55.) No third channel — by design.
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `two-doors-${crypto.randomUUID()}`);
        const workerA = await insertWorker(db, workspaceId);
        const loopA = await insertLoop(db, workerA, 1, "go");
        const workerB = await insertWorker(db, workspaceId);
        const loopB = await insertLoop(db, workerB, 1);
        const turnB = await insertTurn(db, loopB, 1);
        const eng = makeEngine(db);
        const provider = new Mock({ contextWindow: 4096, responses: [okSend(), okSend()] });

        await eng.runTurn({ provider, workspaceId, workerId: workerA, loopId: loopA, messages: MESSAGES, turnNumber: 1 });
        await sleep(2);

        // ENVIRONMENT DOOR — *state*: B's edit to a shared entry crosses to A as a FOLDED delta, not a message.
        await eng.dispatch({ statement: editStmt(urlPath("worker", "/shared.md"), "from sibling B"), workspaceId, workerId: workerB, loopId: loopB, turnId: turnB, sequence: 1, origin: "model" });
        await eng.runTurn({ provider, workspaceId, workerId: workerA, loopId: loopA, messages: MESSAGES, turnNumber: 2 });
        const rows = await (db.engine_render_log as PrepMethod).all<{ origin: string; op: string; pathname: string; source: string | null }>({ worker_id: workerA });
        assert.ok(
            rows.some((r) => r.op === "EDIT" && r.origin === "plurnk" && r.pathname === "/shared.md" && r.source === String(workerB)),
            "environment door: B's shared-entry edit crossed to A as a delta (state, ambient)",
        );

        // VOICE DOOR — *message*: an inject delivers a directed message onto A's own loop's next turn.
        await (db.test_set_loop_status as PrepMethod).run({ id: loopA, status: 102 }); // A is the active loop
        const injected = await eng.inject(workerA, "a directed message for A");
        assert.notEqual(injected, null, "voice door: the inject found A's loop and delivered");
        assert.equal(injected!.loopId, loopA, "the message landed on A's loop — directed, not ambient");
    } finally {
        await db.close();
    }
});

test("an out-of-band disk change surfaces as a source=file delta — the plurnk worker narrates the fs fiction ()", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-envdelta-"));
    const db = await openMigrated();
    try {
        await execFileP("git", ["init", "-q"], { cwd: root, env: hermeticGitEnv() });
        await execFileP("git", ["config", "user.email", "fixture@plurnk.invalid"], { cwd: root, env: hermeticGitEnv() });
        await execFileP("git", ["config", "user.name", "t"], { cwd: root, env: hermeticGitEnv() });
        await writeFile(join(root, "notes.md"), "line1\nline2\n");
        await execFileP("git", ["add", "notes.md"], { cwd: root, env: hermeticGitEnv() });
        await execFileP("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--no-verify", "-q", "-m", "seed"], { cwd: root, env: hermeticGitEnv() });

        const workspaceId = await insertWorkspace(db, `envfs-${crypto.randomUUID()}`);
        await rootWorkspace(db, workspaceId, root);
        const workerA = await insertWorker(db, workspaceId);
        const loopA = await insertLoop(db, workerA, 1, "go");
        const eng = makeEngine(db);
        const provider = new Mock({ contextWindow: 4096, responses: [okSend(), okSend()] });

        // Turn 1 materializes notes.md from disk (first sight — no divergence).
        await eng.runTurn({ provider, workspaceId, workerId: workerA, loopId: loopA, messages: MESSAGES, turnNumber: 1 });
        const afterT1 = await (db.engine_render_log as PrepMethod).all<{ origin: string; op: string; source: string | null }>({ worker_id: workerA });
        assert.ok(!afterT1.some((r) => r.origin === "plurnk" && r.op === "EDIT" && r.source === "file"), "first sight reconciles silently — no fs delta");
        await sleep(2);

        // The file changes out-of-band (an external editor, a git pull).
        await writeFile(join(root, "notes.md"), "line1\nline2\nline3-external\n");

        // Turn 2 — the plurnk worker logs the divergence as a source=file EDIT; A pulls it.
        await eng.runTurn({ provider, workspaceId, workerId: workerA, loopId: loopA, messages: MESSAGES, turnNumber: 2 });
        const rows = await (db.engine_render_log as PrepMethod).all<{ origin: string; op: string; source: string | null; rx: string; pathname: string; expanded: number }>({ worker_id: workerA });
        const delta = rows.find((r) => r.origin === "plurnk" && r.op === "EDIT" && r.source === "file");
        assert.ok(delta, "the out-of-band disk change surfaced as a source=file delta");
        assert.equal(delta!.pathname, "notes.md", "the delta names the diverged file");
        assert.equal(delta!.expanded, 0, "the fs delta lands folded");
        assert.match(JSON.parse(delta!.rx).span as string, /line3-external/, "the delta carries the changed span (§edit-result-render)");
    } finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});

// §worker-scheme loop-termination rides the same env-delta rail: when a sibling's loop
// reaches a terminal status, the observer pulls it at pre-turn as a FOLDED SEND from
// worker://<name> carrying the loop's deliverable — the SEND[200] body or, for an
// abandonment, the reason. The terminated_at trigger stamps every death-path uniformly,
// so a graceful 200 and a grinder 499 surface the same way.
test("a sibling's loop-termination surfaces — a 2xx deliverable born OPEN + awakening, an abandonment folded", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `loopterm-${crypto.randomUUID()}`);
        const workerA = await insertWorker(db, workspaceId);                       // the observer
        const loopA = await insertLoop(db, workerA, 1, "go");
        const worker = await insertWorker(db, workspaceId, null, "worker");      // finishes gracefully
        const workerLoop = await insertLoop(db, worker, 1, "investigate the bug");
        const grinder = await insertWorker(db, workspaceId, null, "grinder");    // gets abandoned
        const grinderLoop = await insertLoop(db, grinder, 1, "grind forever");
        const eng = makeEngine(db);
        const provider = new Mock({ contextWindow: 4096, responses: [okSend(), okSend()] });

        // A's turn 1 sets its "last looked" boundary; the siblings are still running.
        await eng.runTurn({ provider, workspaceId, workerId: workerA, loopId: loopA, messages: MESSAGES, turnNumber: 1 });
        await sleep(2);  // ms-resolution — terminations must land strictly after A's turn 1

        // worker SENDs[200] its result (its deliverable); grinder is abandoned (budget).
        const lifecycle = new LoopLifecycle(db);
        assert.equal(await lifecycle.finish(workerLoop, 200, "the answer is 42"), true);
        assert.equal(await lifecycle.finish(grinderLoop, 413, "budget_overflow"), true);

        // A's turn 2 pulls both terminations from the shared log: the 2xx deliverable born open, the abandonment folded.
        await eng.runTurn({ provider, workspaceId, workerId: workerA, loopId: loopA, messages: MESSAGES, turnNumber: 2 });
        const rows = await (db.engine_render_log as PrepMethod).all<{ scheme: string | null; origin: string; op: string; pathname: string; source: string | null; status_rx: number | null; rx: string; expanded: number }>({ worker_id: workerA });

        const win = rows.find((r) => r.op === "SEND" && r.scheme === "worker" && r.pathname === "/worker");
        assert.ok(win, "worker's SEND[200] termination surfaced as a run-delta in A's log");
        assert.equal(win!.origin, "plurnk", "the termination delta is the engine's narration");
        assert.equal(win!.source, String(worker), "attributed to the worker that terminated");
        assert.equal(win!.status_rx, 200, "the terminal status rides");
        assert.equal(win!.rx, "the answer is 42", "the SEND body — the loop's deliverable — rides the delta");
        assert.equal(win!.expanded, 1, "born OPEN — a child's 2xx deliverable reaches the parent open + awakening, not hidden behind a fold");

        const grind = rows.find((r) => r.op === "SEND" && r.scheme === "worker" && r.pathname === "/grinder");
        assert.ok(grind, "the abandoned loop surfaced too — every death-path stamps terminated_at uniformly");
        assert.equal(grind!.status_rx, 413, "budget abandonment is a 413 Content Too Large termination");
        assert.equal(grind!.rx, "budget_overflow", "the abandon reason rides as the terminal message");
        assert.equal(grind!.source, String(grinder), "attributed to the abandoned run");
        assert.equal(grind!.expanded, 0, "an abandonment (non-2xx) stays folded — only a 2xx deliverable is born open");
    } finally {
        await db.close();
    }
});
