// §send-300-choices — SEND[300]:question;choice;… asks the operator and parks the loop; the parsed
// choice set rides the log row's attrs; the answer returns via the existing inject → wake path.

import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { Mock } from "@plurnk/plurnk-providers";
import type { PrepMethod } from "../../src/core/Db.ts";
import { openMigrated, insertSession, insertRun, insertLoop, DEFAULT_MIMETYPES } from "./_helpers.ts";
import { sendStmt } from "./_dsl.ts";

const send300 = (body: string) => ({ ...sendStmt(300, null, body) });

test("[§send-300-choices] SEND[300] parses the choice set onto the row and PARKS the loop (resumable 202)", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `c300-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "ask");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const r = await engine.runTurn({
            provider: new Mock({ contextSize: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [send300("Which environment?;production;staging;local")] } }] }),
            sessionId, runId, loopId,
            messages: [{ role: "system", content: "SD" }, { role: "user", content: "deploy it" }],
        });
        const loopStatus = (await (db.test_get_loop_status as PrepMethod).get<{ status: number }>({ id: loopId }))?.status;
        assert.equal(loopStatus, 202, "the loop PARKED (resumable) awaiting the operator's answer");
        const rows = await (db.test_log_sequencees_by_turn as PrepMethod).all<{ op: string; status_rx: number }>({ turn_id: r.turnId });
        assert.equal(rows.find((row) => row.op === "SEND")?.status_rx, 300, "the row records the [300] ask");
        const attrs = await (db.test_get_log_entry_attrs_by_turn as PrepMethod).get<{ attrs: string }>({ turn_id: r.turnId, op: "SEND" });
        const parsed = JSON.parse(attrs?.attrs ?? "{}") as { question?: string; choices?: string[] };
        assert.equal(parsed.question, "Which environment?", "attrs carry the question");
        assert.deepEqual(parsed.choices, ["production", "staging", "local"], "attrs carry the choice set — the client's chooser UI reads the log/entry it already streams");
    } finally { await db.close(); }
});

test("[§send-300-choices] a bare [300] with no choices is an OPEN QUESTION — parks the same, never malformed", async () => {
    // Owner ruling: choices are optional chooser sugar; a choiceless [300] simply asks freeform.
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `c300o-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "ask");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const r = await engine.runTurn({
            provider: new Mock({ contextSize: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [send300("What should the deploy tag be?")] } }] }),
            sessionId, runId, loopId,
            messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }],
        });
        const loopStatus = (await (db.test_get_loop_status as PrepMethod).get<{ status: number }>({ id: loopId }))?.status;
        assert.equal(loopStatus, 202, "the open question parks awaiting the operator's freeform answer");
        const attrs = await (db.test_get_log_entry_attrs_by_turn as PrepMethod).get<{ attrs: string }>({ turn_id: r.turnId, op: "SEND" });
        const parsed = JSON.parse(attrs?.attrs ?? "{}") as { question?: string; choices?: string[] };
        assert.equal(parsed.question, "What should the deploy tag be?", "attrs carry the question");
        assert.equal(parsed.choices, undefined, "no choices field for the bare open-question form");
    } finally { await db.close(); }
});

test("[§send-300-choices] e2e: the ask parks, the operator's inject IS the answer, the loop resumes and concludes with it", async () => {
    // The full client contract through the real daemon: the model asks [300], the client (who
    // streams the log/entry carrying {question, choices}) answers via the EXISTING loop.inject,
    // the passive wake resumes the parked loop, and the next turn concludes using the answer.
    const { withDaemon, connect, rpcCall, runLoopToTerminal, makeMockResponse, subscribeNotifications, waitFor, flush } = await import("./_rpc.ts");
    const mock = new Mock({ contextSize: 8192, responses: [
        makeMockResponse("<<PLAN:ask the operator:PLAN\n<<SEND[300]:Which environment?;production;staging:SEND", 10),
        makeMockResponse("<<PLAN:conclude with the chosen environment:PLAN\n<<SEND[200]:Deploying to staging as instructed.:SEND", 10),
    ] });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name: "choices-e2e" });
            const terminated = subscribeNotifications(ws, "loop/terminated");
            const entries = subscribeNotifications(ws, "log/entry");
            await rpcCall(ws, 2, "loop.run", { prompt: "deploy the service", flags: { yolo: true } });
            // The client SEES the ask: a streamed log/entry with signal 300 (attrs carry the choices).
            await waitFor(() => entries() as Array<{ entry?: { signal?: unknown } }>, (items) => items.some((e) => Number(e.entry?.signal) === 300), { timeoutMs: 15_000 });
            // The operator answers through the EXISTING inject path — the passive wake resumes the park.
            await rpcCall(ws, 3, "loop.inject", { prompt: "staging" });
            await waitFor(() => terminated() as Array<{ finalStatus: number }>, (items) => items.some((t) => t.finalStatus === 200), { timeoutMs: 20_000 });
            await flush();
            const done = (terminated() as Array<{ finalStatus: number }>).find((t) => t.finalStatus === 200);
            assert.ok(done !== undefined, "the ask→answer→resume→conclude cycle completed at 200");
        } finally { ws.close(); }
    });
});
