// SPEC §machine-processes — the machine and its processes (session = world, run = log, fork).
//
// These prove the ownership line through BEHAVIOR on the real op surface — never
// by reflecting the schema catalog (no sqlite_master, no PRAGMA: that reaches
// around SqlRite and tests shape instead of conduct). One invariant is true today
// and asserted for real; the rest are deferred-red conformance targets for the epic
// this section defines. {§machine-processes-run-is-its-log} is now GREEN — run_watermarks is
// gone, and the proof (a run learns a sibling's edit purely through its pulled log, no
// shadow) lives in Engine.env-delta.test.ts where the runTurn harness exercises the pull.

import test from "node:test";
import assert from "node:assert/strict";
import type { EditStatement, UrlPath } from "@plurnk/plurnk-grammar";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Fork from "../../src/core/fork.ts";
import type { PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertSession, insertRun, insertLoop, insertTurn } from "./_helpers.ts";

const urlPath = (scheme: string, pathname: string): UrlPath => ({
    kind: "url", raw: `${scheme}://${pathname}`, scheme,
    username: null, password: null, hostname: null, port: null,
    pathname, params: {}, fragment: null,
});
const editStmt = (target: UrlPath, body: string): EditStatement => ({
    op: "EDIT", suffix: "", signal: null, target, lineMarker: null, body,
    position: { line: 1, column: 1 },
});

test("[§machine-processes-one-filesystem] the entries are the session's — a second run writing the same path updates the one shared entry, it does not mint a second", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `ws-${crypto.randomUUID()}`);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const spawn = async () => {
            const runId = await insertRun(db, sessionId);
            const loopId = await insertLoop(db, runId, 1);
            const turnId = await insertTurn(db, loopId, 1);
            return { runId, loopId, turnId };
        };
        const a = await spawn();
        const b = await spawn();
        const target = urlPath("known", "/shared.md");
        const ra = await engine.dispatch({ statement: editStmt(target, "from run A"), sessionId, runId: a.runId, loopId: a.loopId, turnId: a.turnId, sequence: 1, origin: "model" });
        const rb = await engine.dispatch({ statement: editStmt(target, "from run B"), sessionId, runId: b.runId, loopId: b.loopId, turnId: b.turnId, sequence: 1, origin: "model" });
        // A creates the entry (201) in the session's one filesystem; B, a different
        // run at the same (scope, scheme, pathname), UPDATES that one entry (200).
        // A per-run filesystem would have minted a second entry and 201'd again.
        assert.equal(ra.status, 201, "run A creates the entry in the session's filesystem");
        assert.equal(rb.status, 200, "run B writing the SAME path updates the one shared entry — the filesystem is the session's, not the run's");
    } finally { db.close(); }
});

test("[§machine-processes-one-overlay] membership is the session's — one overlay, identical for every run",
    { todo: "membership is session-level; the cross-run-identical proof is a focused test (two runs, one resolved member set) — deferred pending it" }, () => {});

test("[§machine-processes-fork-copies-the-log] a fork copies the parent's log (rows + their fold-state)", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `ws-${crypto.randomUUID()}`);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1);
        const turnId = await insertTurn(db, loopId, 1);
        await engine.dispatch({ statement: editStmt(urlPath("known", "/a.md"), "first"), sessionId, runId, loopId, turnId, sequence: 1, origin: "model" });
        await engine.dispatch({ statement: editStmt(urlPath("known", "/b.md"), "second"), sessionId, runId, loopId, turnId, sequence: 2, origin: "model" });
        // Fold the first row — a fold-state bit on the parent's own log.
        const ids = await (db.test_log_entries_by_run as PrepMethod).all<{ id: number }>({ run_id: runId });
        await (db.log_set_expanded_by_id as PrepMethod).run({ id: ids[0].id, expanded: 0 });

        const branchRunId = await Fork.fork(db, runId);

        const shape = (rows: Array<{ op: string; pathname: string; expanded: number }>) => rows.map((r) => `${r.op}:${r.pathname}:${r.expanded}`);
        const parentLog = await (db.engine_render_log as PrepMethod).all<{ op: string; pathname: string; expanded: number }>({ run_id: runId });
        const branchLog = await (db.engine_render_log as PrepMethod).all<{ op: string; pathname: string; expanded: number }>({ run_id: branchRunId });
        assert.deepEqual(shape(branchLog), shape(parentLog), "the branch's log mirrors the parent's — rows and fold-state");
        assert.ok(branchLog.some((r) => r.expanded === 0), "the row folded on the parent stayed folded in the branch");
    } finally { db.close(); }
});

test("[§machine-processes-fork-shares-the-world] a fork shares the session's filesystem and overlay, live and uncopied", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `ws-${crypto.randomUUID()}`);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1);
        const turnId = await insertTurn(db, loopId, 1);
        await engine.dispatch({ statement: editStmt(urlPath("known", "/shared.md"), "x"), sessionId, runId, loopId, turnId, sequence: 1, origin: "model" });
        const before = (await (db.engine_list_session_entries as PrepMethod).all<{ entry_id: number }>({ session_id: sessionId })).length;

        const branchRunId = await Fork.fork(db, runId);

        const after = (await (db.engine_list_session_entries as PrepMethod).all<{ entry_id: number }>({ session_id: sessionId })).length;
        const branch = await (db.test_run_lineage as PrepMethod).get<{ session_id: number }>({ id: branchRunId });
        assert.equal(branch!.session_id, sessionId, "the branch lives in the parent's session — one shared world");
        assert.equal(after, before, "the fork copied no entries — the filesystem is shared, not duplicated");
    } finally { db.close(); }
});

test("[§machine-processes-no-fork-session] a session cannot be forked; the fork is run-scoped", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `ws-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const branchRunId = await Fork.fork(db, runId);
        assert.notEqual(branchRunId, runId, "a fork is a new run");
        const lineage = await (db.test_run_lineage as PrepMethod).get<{ session_id: number; parent_run_id: number | null }>({ id: branchRunId });
        assert.equal(lineage!.session_id, sessionId, "the branch is in the parent's session — the session is shared, never forked");
        assert.equal(lineage!.parent_run_id, runId, "the branch's lineage points at the parent run");
    } finally { db.close(); }
});
