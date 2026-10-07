// {§effect-policy-tunable} — the deployment override routes an otherwise-auto
// execution through the human gate: with `pure:propose`, an inline jq invocation (whose
// default admission is auto) lands in the proposed state and completes only
// after an explicit accept.

import test from "node:test";
import assert from "node:assert/strict";
import { ownWorker } from "./_approval.ts";
import type { ExecStatement } from "@plurnk/plurnk-contracts";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Exec from "../../src/schemes/Exec.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn } from "./_db.ts";
import { testExecutors } from "./_execs.ts";
import type { RuntimeTag } from "@plurnk/plurnk-contracts";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
        await ownWorker(db, workspaceId, workerId);
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

test("{§configuration-repair-path}: invalid effect policy settles the operation without execution or an orphan proposal", async (t) => {
    const key = "PLURNK_SERVICE_EFFECT_HOST";
    const prior = process.env[key];
    process.env[key] = "invalid";
    t.after(() => { if (prior === undefined) delete process.env[key]; else process.env[key] = prior; });
    const db = await openMigrated();
    t.after(() => db.close());
    const dir = await mkdtemp(join(tmpdir(), "plurnk-invalid-effect-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const marker = join(dir, "executed");
    const schemes = new SchemeRegistry();
    const engine = new Engine({ db, schemes });
    engine.setExecutors(await testExecutors());
    const workspaceId = await insertWorkspace(db, `invalid-effect-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1, "invalid-effect");
    const turnId = await insertTurn(db, loopId, 1, 102);
    let logEntryId = -1;
    const result = await engine.dispatch({
        statement: execStmt("node", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`), workspaceId, workerId, loopId, turnId, sequence: 1, origin: "model",
        onDispatch: (id) => { logEntryId = id; },
    });
    assert.equal(result.status, 503);
    assert.equal(result.problem?.key, key);
    const row = await db.test_get_log_entry_by_id.get<{ state: string; status_rx: number }>({ id: logEntryId });
    assert.equal(row?.status_rx, 503);
    assert.notEqual(row?.state, "proposed");
    assert.deepEqual(await engine.pendingProposals(workspaceId), []);
    await (schemes.get("exec") as Exec).idle();
    await assert.rejects(access(marker), { code: "ENOENT" }, "the operation never executed");
});
