// SPEC §14.8 — the machine and its processes (session = world, run = log, fork).
//
// These prove the ownership line through BEHAVIOR on the real op surface — never
// by reflecting the schema catalog (no sqlite_master, no PRAGMA: that reaches
// around SqlRite and tests shape instead of conduct). One invariant is true today
// and asserted for real; the rest are deferred-red conformance targets for the
// epic this section defines — and {§14.8-run-is-its-log} is red precisely because
// the §14.5 per-run watermark is a shadow memory the model still forbids.

import test from "node:test";
import assert from "node:assert/strict";
import type { EditStatement, UrlPath } from "@plurnk/plurnk-grammar";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
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

test("[§14.8-one-filesystem] the entries are the session's — a second run writing the same path updates the one shared entry, it does not mint a second", async () => {
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

test("[§14.8-one-overlay] membership is the session's — one overlay, identical for every run",
    { todo: "the cross-run-identical-membership proof rides on the run-split (two model runs over one manifest); red until the split lands" }, () => {});

test("[§14.8-run-is-its-log] a run's only memory is its log — no per-run shadow beside it",
    { todo: "VIOLATED today: the §14.5 per-run watermark IS a shadow memory; red until it is struck and drift is broadcast + build-time disk-vs-entry, both landing as log entries" }, () => {});

test("[§14.8-fork-copies-the-log] a fork copies the parent's log (rows + their fold-state) at the savepoint",
    { todo: "the savepoint/branch operation and run.fork are unbuilt — red until the fork primitive lands" }, () => {});

test("[§14.8-fork-shares-the-world] a fork shares the session's filesystem and overlay, live and uncopied",
    { todo: "pairs with the fork operation: a branch reads the parent's entries + overlay, copying nothing of the world" }, () => {});

test("[§14.8-no-fork-session] a session cannot be forked; the surface offers no session.fork",
    { todo: "the fork primitive is run-scoped (run.fork); red until it lands and session.fork's absence is asserted against the live method surface" }, () => {});
