// SPEC §14.7 — the actor boundary (isolation by run, two doors, self-hosting).
//
// The contract landed (Phase 0); this is its rule-C skeleton. One invariant is
// already true and pinned for real (no-mutex); the rest are deferred-red until
// the self-hosting refactor builds the machinery they assert — each cites its
// anchor (so the spec-anchor guard is satisfied) and names the phase that turns
// it green. A red test for an unbuilt contract is the point: it stops §14.7
// shipping as a façade, the way §14.3 membership once did.

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

test("[§14.7-no-mutex] two runs in one session both write the same shared entry — no lock", async () => {
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
        // Wild west = both writers succeed (no lock rejects the second). A creates
        // the shared entry (201), B updates it (200); neither is a 409/lock refusal.
        assert.ok([200, 201].includes(ra.status), `run A's write to the shared entry succeeds (got ${ra.status})`);
        assert.ok([200, 201].includes(rb.status), `run B's write to the SAME entry also succeeds — no mutual exclusion (got ${rb.status})`);
    } finally { db.close(); }
});

test("[§14.7-isolation] a packet renders one run's log; a sibling run's log is absent",
    { todo: "Phase 1 — needs the packet-assembly fixture to prove run B's log entries never enter run A's packet" }, () => {});

test("[§14.7-origin-not-filter] origin is attribution (provenance), never read to hide a row at render",
    { todo: "Phase 1 — pairs with the isolation packet fixture: an in-run row of any origin still renders" }, () => {});

test("[§14.7-two-doors] state crosses runs via the §14.5 delta; messages via inject — no third channel",
    { todo: "Phase 1 — the voice door (inject, #193) is unbuilt; the environment door is exercised under §14.5" }, () => {});

test("[§14.7-passive-wake] an idle run wakes on an inject or a stream-status transition, never on a delta",
    { todo: "Phase 1 — needs inject (#193) plus the idle-run wake path" }, () => {});

test("[§14.7-self-hosting] runtime work is an ephemeral plurnk run firing ops, not a privileged engine pathway",
    { todo: "Phase 2 — the keystone (dispatchAsPlurnk) + the EMI repatriation make this assertable" }, () => {});
