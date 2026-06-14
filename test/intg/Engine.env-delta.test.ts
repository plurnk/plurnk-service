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
    process.env.PLURNK_BUDGET_CEILING = "1000000";  // never overflow — keep the grinder out of it
    const e = new Engine({ db, schemes: new SchemeRegistry() });
    delete process.env.PLURNK_BUDGET_CEILING;
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
        const rows = await (db.engine_render_log as PrepMethod).all<{ scheme: string | null; origin: string; op: string; pathname: string; source: string | null; indexed: number }>({ run_id: runA });
        const delta = rows.find((r) => r.op === "EDIT" && r.origin === "plurnk" && r.scheme === "known" && r.pathname === "/shared.md");
        assert.ok(delta, "A's turn-2 log carries a delta for B's edit");
        assert.equal(delta!.source, String(runB), "the delta is attributed to the sibling run that caused it");
        assert.equal(delta!.indexed, 0, "the broadcast delta lands FOLDED — listed, collapsed until the model OPENs it");
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
        const rows = await (db.engine_render_log as PrepMethod).all<{ origin: string; op: string; source: string | null; rx: string; pathname: string; indexed: number }>({ run_id: runA });
        const delta = rows.find((r) => r.origin === "plurnk" && r.op === "EDIT" && r.source === "file");
        assert.ok(delta, "the out-of-band disk change surfaced as a source=file delta");
        assert.equal(delta!.pathname, "notes.md", "the delta names the diverged file");
        assert.equal(delta!.indexed, 0, "the fs delta lands folded");
        assert.match(JSON.parse(delta!.rx).span as string, /line3-external/, "the delta carries the changed span (§edit-result-render)");
    } finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});
