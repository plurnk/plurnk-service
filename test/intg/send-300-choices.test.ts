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

// Questions: ALLOWED by default (PLURNK_QUESTIONS unset), enabled only when the client
// affirmatively requests per session (settings.questions) — the enabled-path tests do exactly
// what a real interactive client does.
const enableQuestions = async (db: Awaited<ReturnType<typeof openMigrated>>, sessionId: number): Promise<void> => {
    await (db.test_set_session_settings as PrepMethod).run({ id: sessionId, settings: JSON.stringify({ questions: true }) });
};
const withAsk = async <T>(fn: () => Promise<T>): Promise<T> => fn(); // enabled per-session now — wrapper retired in place

const send300 = (body: string) => ({ ...sendStmt(300, null, body) });

test("[§send-300-choices] SEND[300] is a PROPOSAL — stop the world; the accept body IS the answer, in the ask's own rx", async () => { await withAsk(async () => {
    // Owner ruling (#346): the question rides the SAME proposal system as file edits/MCP auths.
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `c300-${crypto.randomUUID()}`);
        await enableQuestions(db, sessionId);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "ask");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const answered: Promise<void> = new Promise((res) => {
            engine.onProposalPending((e: { logEntryId: number; op: string }) => {
                if (e.op === "SEND") { engine.resolveProposal(e.logEntryId, { decision: "accept", body: "staging" }); res(); }
            });
        });
        const r = await engine.runTurn({
            provider: new Mock({ contextSize: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [send300("Which environment?;production;staging;local")] } }] }),
            sessionId, runId, loopId,
            messages: [{ role: "system", content: "SD" }, { role: "user", content: "deploy it" }],
        });
        await answered;
        const loopStatus = (await (db.test_get_loop_status as PrepMethod).get<{ status: number }>({ id: loopId }))?.status;
        assert.equal(loopStatus, 102, "the loop CONTINUES — stop-the-world happened inside the turn, no park");
        assert.equal(r.status, 102, "the turn records a continue, never a 300 terminal");
        const rows = await (db.test_log_sequencees_by_turn as PrepMethod).all<{ op: string; status_rx: number; rx?: string }>({ turn_id: r.turnId });
        assert.equal(rows.find((row) => row.op === "SEND")?.status_rx, 200, "the resolved ask reads 200 — answered");
        const attrs = await (db.test_get_log_entry_attrs_by_turn as PrepMethod).get<{ attrs: string }>({ turn_id: r.turnId, op: "SEND" });
        const parsed = JSON.parse(attrs?.attrs ?? "{}") as { question?: string; choices?: string[] };
        assert.equal(parsed.question, "Which environment?", "attrs carry the question");
        assert.deepEqual(parsed.choices, ["production", "staging", "local"], "attrs carry the choice set — the client's chooser reads the loop/proposal it already renders");
        const sendRow = await (db.test_send_rows_for_run as PrepMethod).all<{ rx: string; status_rx: number }>({ run_id: runId });
        assert.match(sendRow.find((x) => x.status_rx === 200)?.rx ?? "", /staging/, "the ANSWER rides the ask's own rx — the model reads it next packet");
    } finally { await db.close(); }
}); });

test("[§send-300-choices] a bare [300] with no choices is an OPEN QUESTION — same proposal, never malformed", async () => { await withAsk(async () => {
    // Owner ruling: choices are optional chooser sugar; a choiceless [300] simply asks freeform.
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `c300o-${crypto.randomUUID()}`);
        await enableQuestions(db, sessionId);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "ask");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        engine.onProposalPending((e: { logEntryId: number; op: string }) => {
            if (e.op === "SEND") engine.resolveProposal(e.logEntryId, { decision: "accept", body: "v2.1.0" });
        });
        const r = await engine.runTurn({
            provider: new Mock({ contextSize: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [send300("What should the deploy tag be?")] } }] }),
            sessionId, runId, loopId,
            messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }],
        });
        const attrs = await (db.test_get_log_entry_attrs_by_turn as PrepMethod).get<{ attrs: string }>({ turn_id: r.turnId, op: "SEND" });
        const parsed = JSON.parse(attrs?.attrs ?? "{}") as { question?: string; choices?: string[] };
        assert.equal(parsed.question, "What should the deploy tag be?", "the whole body is the question");
        assert.equal(parsed.choices, undefined, "no choices — the client renders free response only");
        const sendRow = await (db.test_send_rows_for_run as PrepMethod).all<{ rx: string; status_rx: number }>({ run_id: runId });
        assert.match(sendRow.find((x) => x.status_rx === 200)?.rx ?? "", /v2\.1\.0/, "the freeform answer rides the rx");
    } finally { await db.close(); }
}); });

test("[§send-300-choices] e2e: the ask stops the world via loop/proposal; loop.resolve's body IS the answer; the model concludes with it", async () => { await withAsk(async () => {
    // The full client contract through the real daemon (owner ruling: the SAME proposal system
    // as file edits): the model asks [300] — even under YOLO the question stops the world (yolo
    // never auto-answers a human question) — the client receives loop/proposal carrying
    // {question, choices}, answers via the EXISTING loop.resolve {decision:"accept", body}, the
    // answer lands in the ask's own rx, and the next turn concludes with it.
    const { withDaemon, connect, rpcCall, makeMockResponse, subscribeNotifications, waitFor, flush } = await import("./_rpc.ts");
    const mock = new Mock({ contextSize: 8192, responses: [
        makeMockResponse("<<PLAN:ask the operator:PLAN\n<<SEND[300]:Which environment?;production;staging:SEND", 10),
        makeMockResponse("<<PLAN:conclude with the chosen environment:PLAN\n<<SEND[200]:Deploying to staging as instructed.:SEND", 10),
    ] });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "session.create", { name: "choices-e2e", settings: { questions: true } });
            const terminated = subscribeNotifications(ws, "loop/terminated");
            const proposals = subscribeNotifications(ws, "loop/proposal");
            await rpcCall(ws, 2, "loop.run", { prompt: "deploy the service", flags: { yolo: true } });
            // The client SEES the ask: a loop/proposal whose attrs carry the question + choices.
            await waitFor(() => proposals() as Array<{ logEntryId?: number; attrs?: { question?: string; choices?: string[] } }>, (items) => items.some((e) => e.attrs?.question === "Which environment?"), { timeoutMs: 15_000 });
            await flush();
            const ask = (proposals() as Array<{ logEntryId: number; attrs?: { question?: string; choices?: string[] } }>).find((e) => e.attrs?.question !== undefined)!;
            assert.deepEqual(ask.attrs?.choices, ["production", "staging"], "the chooser payload rides the proposal the client already renders");
            // The operator answers through the EXISTING resolve path — the accept body is the answer.
            await rpcCall(ws, 3, "loop.resolve", { logEntryId: ask.logEntryId, decision: "accept", body: "staging" });
            await waitFor(() => terminated() as Array<{ finalStatus: number }>, (items) => items.some((t) => t.finalStatus === 200), { timeoutMs: 20_000 });
            await flush();
            const done = (terminated() as Array<{ finalStatus: number }>).find((t) => t.finalStatus === 200);
            assert.ok(done !== undefined, "the ask→answer→continue→conclude cycle completed at 200");
        } finally { ws.close(); }
    });
}); });


test("[§send-300-choices] not enabled by default — a [300] without the client's request is refused with a self-decide steer", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `c300off-${crypto.randomUUID()}`);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "ask");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const r = await engine.runTurn({
            provider: new Mock({ contextSize: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [send300("Which env?;prod;staging")] } }] }),
            sessionId, runId, loopId,
            messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }],
        });
        const loopStatus = (await (db.test_get_loop_status as PrepMethod).get<{ status: number }>({ id: loopId }))?.status;
        assert.equal(loopStatus, 102, "no park — nobody is watching to answer");
        const rows = await (db.test_log_sequencees_by_turn as PrepMethod).all<{ op: string; status_rx: number }>({ turn_id: r.turnId });
        assert.equal(rows.find((row) => row.op === "SEND")?.status_rx, 409, "the ask is refused with the self-decide steer");
    } finally { await db.close(); }
});

test("[§send-300-choices] settings.questions=true (the client's affirmative request) enables the session", async () => {
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `c300on-${crypto.randomUUID()}`);
        await (db.test_set_session_settings as PrepMethod).run({ id: sessionId, settings: JSON.stringify({ questions: true }) });
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "ask");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        engine.onProposalPending((e: { logEntryId: number; op: string }) => {
            if (e.op === "SEND") engine.resolveProposal(e.logEntryId, { decision: "accept", body: "prod" });
        });
        await engine.runTurn({
            provider: new Mock({ contextSize: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [send300("Which env?;prod;staging")] } }] }),
            sessionId, runId, loopId,
            messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }],
        });
        const answered = await (db.test_send_rows_for_run as PrepMethod).all<{ rx: string; status_rx: number }>({ run_id: runId });
        assert.match(answered.find((x) => x.status_rx === 200)?.rx ?? "", /prod/, "the interactive session's ask STOPPED THE WORLD and got its answer — the client enabled it");
    } finally { await db.close(); }
});

test("[§send-300-choices] PLURNK_QUESTIONS=0 is a servicewide ceiling — the client's request cannot override it", async () => {
    const prev = process.env.PLURNK_QUESTIONS;
    process.env.PLURNK_QUESTIONS = "0";
    const db = await openMigrated();
    try {
        const sessionId = await insertSession(db, `c300deny-${crypto.randomUUID()}`);
        await enableQuestions(db, sessionId);
        const runId = await insertRun(db, sessionId);
        const loopId = await insertLoop(db, runId, 1, "ask");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        await engine.runTurn({
            provider: new Mock({ contextSize: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [send300("Which env?;prod;staging")] } }] }),
            sessionId, runId, loopId,
            messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }],
        });
        const loopStatus = (await (db.test_get_loop_status as PrepMethod).get<{ status: number }>({ id: loopId }))?.status;
        assert.equal(loopStatus, 102, "denied servicewide — even a requesting session cannot park an ask");
    } finally {
        await db.close();
        if (prev === undefined) delete process.env.PLURNK_QUESTIONS; else process.env.PLURNK_QUESTIONS = prev;
    }
});

test("[§send-300-choices] the teaching injects ONLY where enabled — docEntries carries questions.md for the requesting session, not the default one", async () => {
    // The installed docs package (0.1.1) predates questions.md — seed the REAL read location so
    // the mechanism is exercised on the real path; restored after. Redundant-but-harmless once
    // docs 0.1.2 ships the file.
    const { writeFileSync, unlinkSync, existsSync, readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const Paths = (await import("../../src/Paths.ts")).default;
    const qPath = resolve(Paths.schemeDocs, "questions.md");
    const hadFile = existsSync(qPath);
    const original = hadFile ? readFileSync(qPath, "utf8") : null;
    writeFileSync(qPath, "# Operator questions\nChoices are suggestions — the operator always has a free-text option.\n");
    const db = await openMigrated();
    try {
        const off = await insertSession(db, `qdoc-off-${crypto.randomUUID()}`);
        const on = await insertSession(db, `qdoc-on-${crypto.randomUUID()}`);
        await enableQuestions(db, on);
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const offDocs = await engine.docEntries(off);
        const onDocs = await engine.docEntries(on);
        assert.ok(!offDocs.some((d) => d.name === "questions"), "an un-enabled session is never taught the op it can't use");
        assert.ok(onDocs.some((d) => d.name === "questions" && /free-text/.test(d.content)), "the enabled session gets questions.md — including the always-free-text answer teaching");
    } finally {
        await db.close();
        if (original !== null) writeFileSync(qPath, original); else if (existsSync(qPath)) unlinkSync(qPath);
    }
});

test("[§proposal-list] a reconnecting client DISCOVERS the stopped world — the pending question, then answers it via loop.resolve", async () => { await withAsk(async () => {
    // The indefinite-wait ruling's companion: the ask stops the world; a SECOND connection
    // (the reconnect) lists the pending proposal cold — no notification needed — and answers.
    const { withDaemon, connect, rpcCall, makeMockResponse, subscribeNotifications, waitFor, flush } = await import("./_rpc.ts");
    const mock = new Mock({ contextSize: 8192, responses: [
        makeMockResponse("<<PLAN:ask:PLAN\n<<SEND[300]:Which environment?;production;staging:SEND", 10),
        makeMockResponse("<<PLAN:conclude:PLAN\n<<SEND[200]:Deploying to staging.:SEND", 10),
    ] });
    await withDaemon(mock, async (_db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "session.create", { name: "plist-e2e", settings: { questions: true } });
            const sessionId = (created.result as { id: number }).id;
            const proposals = subscribeNotifications(ws, "loop/proposal");
            const terminated = subscribeNotifications(ws, "loop/terminated");
            await rpcCall(ws, 2, "loop.run", { prompt: "deploy", flags: { yolo: true } });
            await waitFor(() => proposals() as Array<{ attrs?: { question?: string } }>, (items) => items.some((e) => e.attrs?.question !== undefined), { timeoutMs: 15_000 });
            // THE RECONNECT: a fresh connection attaches and discovers the stopped world cold.
            const ws2 = await connect(addr);
            try {
                await rpcCall(ws2, 1, "session.attach", { id: sessionId });
                const listed = await rpcCall(ws2, 2, "proposal.list", {});
                const result = listed.result as { proposals: Array<{ logEntryId: number; op: string; attrs: { question?: string; choices?: string[] } }> };
                assert.equal(result.proposals.length, 1, "the stopped world is DISCOVERABLE");
                assert.equal(result.proposals[0]!.attrs.question, "Which environment?");
                assert.deepEqual(result.proposals[0]!.attrs.choices, ["production", "staging"]);
                await rpcCall(ws2, 3, "loop.resolve", { logEntryId: result.proposals[0]!.logEntryId, decision: "accept", body: "staging" });
            } finally { ws2.close(); }
            await waitFor(() => terminated() as Array<{ finalStatus: number }>, (items) => items.some((t) => t.finalStatus === 200), { timeoutMs: 20_000 });
            await flush();
            const after = await rpcCall(ws, 9, "proposal.list", {});
            assert.equal((after.result as { proposals: unknown[] }).proposals.length, 0, "resolved — the list empties");
        } finally { ws.close(); }
    });
}); });
