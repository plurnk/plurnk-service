// {§effect-policy-tunable} — the deployment override routes an otherwise-auto
// execution through the human gate: with `pure:propose`, an inline jq invocation (whose
// default admission is auto) lands in the proposed state and completes only
// after an explicit accept.

import test from "node:test";
import assert from "node:assert/strict";
import type { ExecStatement } from "@plurnk/plurnk-contracts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Exec from "../../src/schemes/Exec.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn, testExecutors } from "./_helpers.ts";
import type { RuntimeTag } from "@plurnk/plurnk-contracts";

process.env.PLURNK_EXECS_JQ = "1";

const execStmt = (runtime: string, body: string): ExecStatement => ({
    metadata: null,
    runtime: (runtime ?? "sh") as RuntimeTag, aside: null, target: null, lineMarker: null, body, position: { line: 1, column: 1 },
});

test("{§effect-policy-tunable}: proposing pure routes an otherwise-auto execution through the human gate", async () => {
    const prior = process.env.PLURNK_SERVICE_EFFECT_PURE;
    process.env.PLURNK_SERVICE_EFFECT_PURE = "propose";
    const db = await openMigrated();
    try {
        const schemes = new SchemeRegistry();
        const exec = schemes.get("exec") as Exec;
        const engine = new Engine({ db, schemes });
        engine.setExecutors(await testExecutors());
        const workspaceId = await insertWorkspace(db, `effect-policy-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "effect-policy");
        const turnId = await insertTurn(db, loopId, 1, 102);

        let logEntryId = -1;
        const dispatched = engine.dispatch({
            statement: execStmt("jq", "[1,2,3] | add"),
            workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
            onDispatch: (id) => { logEntryId = id; },
        });
        await new Promise((resolve) => setTimeout(resolve, 50));
        const row = await db.test_get_log_entry_by_id.get<{ state: string }>({ id: logEntryId });
        assert.equal(row?.state, "proposed", "the overridden pure execution proposes instead of auto-running");
        engine.resolveProposal(logEntryId, { decision: "accept" });
        const result = await dispatched;
        await exec.idle();
        assert.equal(result.status, 200, "the accepted override-gated execution completes normally");
    } finally {
        if (prior === undefined) delete process.env.PLURNK_SERVICE_EFFECT_PURE;
        else process.env.PLURNK_SERVICE_EFFECT_PURE = prior;
        await db.close();
    }
});
