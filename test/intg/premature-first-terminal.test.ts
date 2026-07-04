// Regression: the premature-terminate gate must judge the FIRST terminal SEND (the one dispatch
// concludes on), not findLast. A grammar-unenforced stroke can emit multiple terminals
// (…SEND[200]…SEND[202]); the first SEND[200] here follows a READ, so it is a submitted-read
// premature-terminate and must be refused 409 — the loop must NOT conclude 200 on unread data.
// This is the shape that leaked live (host-field/config-host 1-turn wrong answers).

import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import type { PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertSession, insertRun, insertLoop, DEFAULT_MIMETYPES } from "./_helpers.ts";
import { readStmt, sendStmt } from "./_dsl.ts";
import type { PlurnkStatement } from "@plurnk/plurnk-grammar";

const url = (p: string) => ({ kind: "url" as const, raw: `known:///${p}`, scheme: "known", username: null, password: null, hostname: null, port: null, pathname: `/${p}`, params: {}, fragment: null });

test("stroke with a leading SEND[200] and a trailing SEND[202]: the FIRST terminal is refused submitted-read", async () => {
    const db = await openMigrated();
    try {
        const sid = await insertSession(db, `pf-${crypto.randomUUID()}`); const rid = await insertRun(db, sid); const lid = await insertLoop(db, rid, 1, "go");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        // findLast would bind the reason to the trailing SEND[202]; dispatch concludes on the SEND[200].
        const ops: PlurnkStatement[] = [readStmt(url("cfg")), sendStmt(200, null, "localhost"), readStmt(url("cfg")), sendStmt(202, null, "park")];
        const provider = new Mock({ contextSize: 100000, responses: [{ assistant: { content: "", reasoning: null, ops } }, { assistant: { content: "", reasoning: null, ops: [sendStmt(102, null, "wait")] } }] });
        const r = await engine.runTurn({ provider, sessionId: sid, runId: rid, loopId: lid, messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }] });
        assert.notEqual(r.status, 200, `the first SEND[200] must be refused, not conclude the loop; got ${r.status}`);
        const send = await (db.test_read_log_entries_for_turn_by_op as PrepMethod).get<{ status_rx: number }>({ turn_id: r.turnId, op: "SEND" });
        assert.equal(send?.status_rx, 409, "the leading SEND[200] refused submitted-read (409)");
    } finally { await db.close(); }
});
