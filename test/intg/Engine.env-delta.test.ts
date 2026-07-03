// SPEC §env-delta / §machine-processes — the environment delta as a PULL from the
// shared log. No per-run snapshot: every edit is already a span-carrying log row, so
// at pre-turn a run surfaces other actors' edits on shared entries since its OWN last
// turn, folded. Two producers: real cross-run edits (a sibling's EDIT) and the
// filesystem-as-the-plurnk-run fs-sync fictions (source=file) for ambient disk drift.

import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Envelope from "../../src/server/envelope.ts";
import { Mock } from "@plurnk/plurnk-providers";
import type { MockResponse } from "@plurnk/plurnk-providers";
import type { SendStatement, EditStatement, UrlPath } from "@plurnk/plurnk-grammar";
import type { Db, PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertSession, insertRun, insertLoop, insertTurn } from "./_helpers.ts";

const execFileP = promisify(execFile);

const okSend = (): MockResponse => ({
    assistant: {
        content: "",
        ops: [{ op: "SEND", suffix: "", signal: 200, target: null, lineMarker: null, body: { raw: "ok", json: null }, position: { line: 1, column: 1 } } as SendStatement],
        reasoning: null, usage: { prompt: 0, completion: 0, reasoning: 0, cached: 0, total: 0 },
    },
});
const MESSAGES = [{ role: "system" as const, content: "You are an agent." }, { role: "user" as const, content: "go" }];

const makeEngine = (db: Db): Engine => {
    process.env.PLURNK_SERVICE_CTX = "1000000"; process.env.PLURNK_SERVICE_REASONING = "0"; process.env.PLURNK_SERVICE_ASSISTANT = "0"; process.env.PLURNK_SERVICE_SAFETY = "0";  // never overflow — keep the grinder out of it
    const e = new Engine({ db, schemes: new SchemeRegistry() });
    for (const k of ["CTX", "REASONING", "ASSISTANT", "SAFETY"]) delete process.env[`PLURNK_SERVICE_${k}`];
    return e;
};

const urlPath = (scheme: string, pathname: string): UrlPath => ({
    kind: "url", raw: `${scheme}://${pathname}`, scheme,
    username: null, password: null, hostname: null, port: null,
    pathname, params: {}, fragment: null,
});
const editStmt = (target: UrlPath, body: string): EditStatement => ({
    op: "EDIT", suffix: "", signal: null, target, lineMarker: null, body,
    position: { line: 1, column: 1 },
});

test("[§machine-processes-run-is-its-log] a run learns a sibling's edit through its own log — pulled from the shared log, no per-run snapshot", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `xrun-${crypto.randomUUID()}`);
        const runA = await insertRun(db, sessionId);            // the model's run
        const loopA = await insertLoop(db, runA, 1, "go");
        const runB = await insertRun(db, sessionId);            // a sibling run on the same world
        const loopB = await insertLoop(db, runB, 1);
        const turnB = await insertTurn(db, loopB, 1);
        const eng = makeEngine(db);
        const provider = new Mock({ contextSize: 4096, responses: [okSend(), okSend()] });

        // A's turn 1 sets its "last looked" boundary; nothing happened before it, so no deltas.
        await eng.runTurn({ provider, sessionId, runId: runA, loopId: loopA, messages: MESSAGES, turnNumber: 1 });
        await sleep(2);  // ms-resolution timestamps — ensure B's edit lands strictly after A's turn 1

        // B edits a shared entry — a real EDIT row in B's own log.
        const edit = await eng.dispatch({ statement: editStmt(urlPath("known", "/shared.md"), "from sibling B"), sessionId, runId: runB, loopId: loopB, turnId: turnB, sequence: 1, origin: "model" });
        assert.ok(edit.status === 200 || edit.status === 201, "B's edit to the shared entry lands");

        // A's turn 2 pulls B's edit from the shared log as a FOLDED delta — A consulted no
        // per-run snapshot; it learned its world moved purely through its own log.
        await eng.runTurn({ provider, sessionId, runId: runA, loopId: loopA, messages: MESSAGES, turnNumber: 2 });
        const rows = await (db.engine_render_log as PrepMethod).all<{ scheme: string | null; origin: string; op: string; pathname: string; source: string | null; expanded: number }>({ run_id: runA });
        const delta = rows.find((r) => r.op === "EDIT" && r.origin === "plurnk" && r.scheme === "known" && r.pathname === "/shared.md");
        assert.ok(delta, "A's turn-2 log carries a delta for B's edit");
        assert.equal(delta!.source, String(runB), "the delta is attributed to the sibling run that caused it");
        assert.equal(delta!.expanded, 0, "the broadcast delta lands FOLDED — listed, collapsed until the model OPENs it");
    } finally {
        await db.close();
    }
});

test("[§actor-boundary-two-doors] exactly two cross-run channels — state via the env-delta, a message via inject", async () => {
    // Both doors in one place. (Was a stale `unbuilt` todo stub — the voice door IS built: inject,
    // and irc through it, resume parked runs in place, #55.) No third channel — by design.
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `two-doors-${crypto.randomUUID()}`);
        const runA = await insertRun(db, sessionId);
        const loopA = await insertLoop(db, runA, 1, "go");
        const runB = await insertRun(db, sessionId);
        const loopB = await insertLoop(db, runB, 1);
        const turnB = await insertTurn(db, loopB, 1);
        const eng = makeEngine(db);
        const provider = new Mock({ contextSize: 4096, responses: [okSend(), okSend()] });

        await eng.runTurn({ provider, sessionId, runId: runA, loopId: loopA, messages: MESSAGES, turnNumber: 1 });
        await sleep(2);

        // ENVIRONMENT DOOR — *state*: B's edit to a shared entry crosses to A as a FOLDED delta, not a message.
        await eng.dispatch({ statement: editStmt(urlPath("known", "/shared.md"), "from sibling B"), sessionId, runId: runB, loopId: loopB, turnId: turnB, sequence: 1, origin: "model" });
        await eng.runTurn({ provider, sessionId, runId: runA, loopId: loopA, messages: MESSAGES, turnNumber: 2 });
        const rows = await (db.engine_render_log as PrepMethod).all<{ origin: string; op: string; pathname: string; source: string | null }>({ run_id: runA });
        assert.ok(
            rows.some((r) => r.op === "EDIT" && r.origin === "plurnk" && r.pathname === "/shared.md" && r.source === String(runB)),
            "environment door: B's shared-entry edit crossed to A as a delta (state, ambient)",
        );

        // VOICE DOOR — *message*: an inject delivers a directed message onto A's own loop's next turn.
        await (db.test_set_loop_status as PrepMethod).run({ id: loopA, status: 102 }); // A is the active loop
        const injected = await eng.inject(runA, "a directed message for A");
        assert.notEqual(injected, null, "voice door: the inject found A's loop and delivered");
        assert.equal(injected!.loopId, loopA, "the message landed on A's loop — directed, not ambient");
    } finally {
        await db.close();
    }
});

test("an out-of-band disk change surfaces as a source=file delta — the plurnk run narrates the fs fiction (§env-delta)", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-envdelta-"));
    const db = await openMigrated();
    try {
        await execFileP("git", ["init", "-q"], { cwd: root });
        await execFileP("git", ["config", "user.email", "t@t.t"], { cwd: root });
        await execFileP("git", ["config", "user.name", "t"], { cwd: root });
        await writeFile(join(root, "notes.md"), "line1\nline2\n");
        await execFileP("git", ["add", "notes.md"], { cwd: root });
        await execFileP("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--no-verify", "-q", "-m", "seed"], { cwd: root });

        const sessionId = await insertSession(db, `envfs-${crypto.randomUUID()}`);
        await Envelope.updateSessionProjectRoot(db, sessionId, root);
        const runA = await insertRun(db, sessionId);
        const loopA = await insertLoop(db, runA, 1, "go");
        const eng = makeEngine(db);
        const provider = new Mock({ contextSize: 4096, responses: [okSend(), okSend()] });

        // Turn 1 materializes notes.md from disk (first sight — no divergence).
        await eng.runTurn({ provider, sessionId, runId: runA, loopId: loopA, messages: MESSAGES, turnNumber: 1 });
        const afterT1 = await (db.engine_render_log as PrepMethod).all<{ origin: string; op: string; source: string | null }>({ run_id: runA });
        assert.ok(!afterT1.some((r) => r.origin === "plurnk" && r.op === "EDIT" && r.source === "file"), "first sight reconciles silently — no fs delta");
        await sleep(2);

        // The file changes out-of-band (an external editor, a git pull).
        await writeFile(join(root, "notes.md"), "line1\nline2\nline3-external\n");

        // Turn 2 — the plurnk run logs the divergence as a source=file EDIT; A pulls it.
        await eng.runTurn({ provider, sessionId, runId: runA, loopId: loopA, messages: MESSAGES, turnNumber: 2 });
        const rows = await (db.engine_render_log as PrepMethod).all<{ origin: string; op: string; source: string | null; rx: string; pathname: string; expanded: number }>({ run_id: runA });
        const delta = rows.find((r) => r.origin === "plurnk" && r.op === "EDIT" && r.source === "file");
        assert.ok(delta, "the out-of-band disk change surfaced as a source=file delta");
        assert.equal(delta!.pathname, "/notes.md", "the delta names the diverged file");
        assert.equal(delta!.expanded, 0, "the fs delta lands folded");
        assert.match(JSON.parse(delta!.rx).span as string, /line3-external/, "the delta carries the changed span (§edit-result-render)");
    } finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});

// §run-scheme loop-termination rides the same env-delta rail: when a sibling's loop
// reaches a terminal status, the observer pulls it at pre-turn as a FOLDED SEND from
// run://<name> carrying the loop's deliverable — the SEND[200] body or, for an
// abandonment, the reason. The terminated_at trigger stamps every death-path uniformly,
// so a graceful 200 and a grinder 499 surface the same way.
test("[§run-scheme-collect] a sibling's loop-termination surfaces — a 2xx deliverable born OPEN + awakening, an abandonment folded", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `loopterm-${crypto.randomUUID()}`);
        const runA = await insertRun(db, sessionId);                       // the observer
        const loopA = await insertLoop(db, runA, 1, "go");
        const worker = await insertRun(db, sessionId, null, "worker");      // finishes gracefully
        const workerLoop = await insertLoop(db, worker, 1, "investigate the bug");
        const grinder = await insertRun(db, sessionId, null, "grinder");    // gets abandoned
        const grinderLoop = await insertLoop(db, grinder, 1, "grind forever");
        const eng = makeEngine(db);
        const provider = new Mock({ contextSize: 4096, responses: [okSend(), okSend()] });

        // A's turn 1 sets its "last looked" boundary; the siblings are still running.
        await eng.runTurn({ provider, sessionId, runId: runA, loopId: loopA, messages: MESSAGES, turnNumber: 1 });
        await sleep(2);  // ms-resolution — terminations must land strictly after A's turn 1

        // worker SENDs[200] its result (its deliverable); grinder is abandoned (budget).
        await (db.engine_loop_set_status as PrepMethod).run({ status: 200, loop_id: workerLoop, message: "the answer is 42" });
        await (db.engine_loop_set_status as PrepMethod).run({ status: 413, loop_id: grinderLoop, message: "budget_overflow" });

        // A's turn 2 pulls both terminations from the shared log: the 2xx deliverable born open, the abandonment folded.
        await eng.runTurn({ provider, sessionId, runId: runA, loopId: loopA, messages: MESSAGES, turnNumber: 2 });
        const rows = await (db.engine_render_log as PrepMethod).all<{ scheme: string | null; origin: string; op: string; pathname: string; source: string | null; status_rx: number | null; rx: string; expanded: number }>({ run_id: runA });

        const win = rows.find((r) => r.op === "SEND" && r.scheme === "run" && r.pathname === "/worker");
        assert.ok(win, "worker's SEND[200] termination surfaced as a run-delta in A's log");
        assert.equal(win!.origin, "plurnk", "the termination delta is the engine's narration");
        assert.equal(win!.source, String(worker), "attributed to the run that terminated");
        assert.equal(win!.status_rx, 200, "the terminal status rides");
        assert.equal(win!.rx, "the answer is 42", "the SEND body — the loop's deliverable — rides the delta");
        assert.equal(win!.expanded, 1, "born OPEN — a child's 2xx deliverable reaches the parent open + awakening, not hidden behind a fold");

        const grind = rows.find((r) => r.op === "SEND" && r.scheme === "run" && r.pathname === "/grinder");
        assert.ok(grind, "the abandoned loop surfaced too — every death-path stamps terminated_at uniformly");
        assert.equal(grind!.status_rx, 413, "budget abandonment is a 413 Content Too Large termination");
        assert.equal(grind!.rx, "budget_overflow", "the abandon reason rides as the terminal message");
        assert.equal(grind!.source, String(grinder), "attributed to the abandoned run");
        assert.equal(grind!.expanded, 0, "an abandonment (non-2xx) stays folded — only a 2xx deliverable is born open");
    } finally {
        await db.close();
    }
});
