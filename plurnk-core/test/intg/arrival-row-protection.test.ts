// {§message-arrival}. Arrival rows are ordinary curatable log memory.
import test from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { Mock } from "@plurnk/plurnk-providers";
import { openMigrated, insertWorkspace, insertSession, insertLoop, insertTurn } from "./_db.ts";
import { DEFAULT_MIMETYPES } from "./_scheme.ts";
import { editStmt, killStmt, noteStmt } from "./_dsl.ts";

const urlLog = (raw: string) => ({ kind: "url" as const, raw, scheme: "log", username: null, password: null, hostname: null, port: null, pathname: "/" + raw.replace(/^log:\/\/\//, ""), query: null, fragment: null });
const urlSession = (raw: string) => ({ kind: "url" as const, raw, scheme: "workspace", username: null, password: null, hostname: null, port: null, pathname: "/" + raw.replace(/^workspace:\/\/\//, ""), query: null, fragment: null });

async function seedPromptSession(db: Awaited<ReturnType<typeof openMigrated>>) {
    const workspaceId = await insertWorkspace(db, `frame-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId);
    const loopId = await insertLoop(db, sessionId, 1, "go");
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
    // {§message-arrival}: the initial message has one inbound SEND row.
    await engine.runTurn({
        provider: new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [noteStmt("Continue.")] } }] }),
        workspaceId, sessionId, loopId, messages: [{ role: "system", content: "SD" }, { role: "user", content: "Improve the module loader so require() stays deterministic." }],
    });
    const next = await db.engine_next_turn_sequence.get<{ next: number }>({ loop_id: loopId });
    if (next === undefined) throw new Error("next turn sequence unavailable");
    const curationTurn = await insertTurn(db, loopId, next.next, 102);
    return { workspaceId, sessionId, loopId, engine, curationTurn };
}

test("{§message-arrival} an explicit scoped KILL of the arrival row is ordinary curation", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, sessionId, loopId, engine, curationTurn } = await seedPromptSession(db);
        // Turn 1 is initialization; the first model turn's arrival is turn 2, row 1.
        const r = await engine.dispatch({ statement: killStmt(urlLog("log:///1/2/1/SEND"), { marks: [1, -1] }), workspaceId, sessionId, loopId, turnId: curationTurn, sequence: 1, origin: "model" });
        assert.equal(r.status, 200, "the valid arrival row accepts scoped KILL like every other visible row");
        assert.equal((r as { matched?: number }).matched, 1);
        const visibility = await db.test_arrival_folded.get<{ folded: string }>({});
        assert.equal(visibility?.folded, "[[1,-1]]", "the explicit curation request is honored");
    } finally { await db.close(); }
});
test("{§message-arrival} prior and current loop arrivals share the same explicit curation contract", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, sessionId, engine } = await seedPromptSession(db);
        // A second loop takes over; loop 1's arrival becomes curatable history.
        const loop2 = await insertLoop(db, sessionId, 2, "the next task");
        await engine.runTurn({
            provider: new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [noteStmt("Continue.")] } }] }),
            workspaceId, sessionId, loopId: loop2, messages: [{ role: "system", content: "SD" }, { role: "user", content: "the next task" }],
        });
        const curationTurn = await insertTurn(db, loop2, 2, 102);
        const stale = await engine.dispatch({ statement: killStmt(urlLog("log:///1/2/1/SEND"), { marks: [1, -1] }), workspaceId, sessionId, loopId: loop2, turnId: curationTurn, sequence: 1, origin: "model" });
        assert.equal(stale.status, 200, "the old loop's arrival accepts scoped KILL");
        assert.equal((stale as { matched?: number }).matched, 1, "the KILL matched the stale arrival row - not a vacuous zero-match 200");
        // Loop 2 has no initialization, so its arrival is row 1.
        const current = await engine.dispatch({ statement: killStmt(urlLog("log:///2/1/1/SEND"), { marks: [1, -1] }), workspaceId, sessionId, loopId: loop2, turnId: curationTurn, sequence: 2, origin: "model" });
        assert.equal(current.status, 200, "the current arrival accepts scoped KILL under the same valid-row contract");
    } finally { await db.close(); }
});

test("{§message-arrival} KILL of the arrival remains deliberate curation", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, sessionId, loopId, engine, curationTurn } = await seedPromptSession(db);
        const r = await engine.dispatch({ statement: killStmt(urlLog("log:///1/2/1/SEND")), workspaceId, sessionId, loopId, turnId: curationTurn, sequence: 1, origin: "model" });
        assert.ok(r.status < 400, `KILL of the arrival succeeds (deliberate) — got ${r.status}`);
    } finally { await db.close(); }
});

test("{§message-arrival} sister sessions' initial messages have independent inbox rows and publications", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `frame-sisters-${crypto.randomUUID()}`);
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const mkProvider = () => new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [noteStmt("Continue.")] } }] });
        const parentSession = await insertSession(db, workspaceId);
        const parentLoop = await insertLoop(db, parentSession, 1, "the parent task");
        await engine.runTurn({ provider: mkProvider(), workspaceId, sessionId: parentSession, loopId: parentLoop, messages: [{ role: "system", content: "SD" }, { role: "user", content: "the parent task" }] });
        const childSession = await insertSession(db, workspaceId);
        const sessionLoop = await insertLoop(db, childSession, 1, "the session task");
        await engine.runTurn({ provider: mkProvider(), workspaceId, sessionId: childSession, loopId: sessionLoop, messages: [{ role: "system", content: "SD" }, { role: "user", content: "the session task" }] });

        const inboxOf = (loopId: number) => db.test_messages_by_loop.all<{ body: string; log_entry_id: number | null }>({ loop_id: loopId });
        const parentRows = await inboxOf(parentLoop);
        const sessionRows = await inboxOf(sessionLoop);
        assert.equal(parentRows.length, 1, "the parent's message exists in its own loop's inbox");
        assert.equal(sessionRows.length, 1, "the session's message exists in ITS loop's inbox");
        assert.equal(parentRows[0].body, "the parent task", "the session's turn-1 foist did not clobber the parent's task");
        assert.equal(sessionRows[0].body, "the session task");
        assert.ok(parentRows[0].log_entry_id !== null && sessionRows[0].log_entry_id !== null, "both were published");
        assert.notEqual(parentRows[0].log_entry_id, sessionRows[0].log_entry_id, "each became its own row");
    } finally { await db.close(); }
});

test("a scoped KILL is recorded in the DB but never renders ({§log-kill-meta-operation})", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, sessionId, loopId, engine, curationTurn } = await seedPromptSession(db);
        // Seed a genuine non-arrival row (a workspace:/// note), then scoped-KILL it so the success records.
        await engine.dispatch({ statement: editStmt(urlSession("workspace:///scratch"), "note"), workspaceId, sessionId, loopId, turnId: curationTurn, sequence: 1, origin: "model" });
        await engine.dispatch({ statement: killStmt(urlLog("log:///1/3/1/EDIT"), { marks: [1, -1] }), workspaceId, sessionId, loopId, turnId: curationTurn, sequence: 2, origin: "model" });
        const dbRow = await db.test_count_op.get<{ n: number }>({ op: "KILL" });
        assert.ok((dbRow?.n ?? 0) >= 1, "the scoped KILL is recorded in the DB (forensics)");
        const rendered = await db.engine_render_log.all<{ op: string; status_rx: number }>({ session_id: sessionId });
        assert.ok(!rendered.some((r) => r.op === "KILL"), "the successful scoped KILL is absent immediately");
        const next = await db.engine_next_turn_sequence.get<{ next: number }>({ loop_id: loopId });
        const laterTurn = await insertTurn(db, loopId, next!.next, 102);
        await engine.dispatch({ statement: editStmt(urlSession("workspace:///scratch2"), "later"), workspaceId, sessionId, loopId, turnId: laterTurn, sequence: 1, origin: "model" });
        const later = await db.engine_render_log.all<{ op: string }>({ session_id: sessionId });
        assert.ok(!later.some((r) => r.op === "KILL"), "the successful receipt remains absent on later turns");
        const stillRecorded = await db.test_count_op.get<{ n: number }>({ op: "KILL" });
        assert.equal(stillRecorded?.n, dbRow?.n, "history is append-only: the suppressed receipt remains in the DB");
    } finally { await db.close(); }
});

test("a successful log-item KILL never renders; a non-log KILL renders and stays ({§log-kill-meta-operation})", async () => {
    const db = await openMigrated();
    try {
        const { workspaceId, sessionId, loopId, engine, curationTurn } = await seedPromptSession(db);
        // Two seeds: a workspace:/// note (a real artifact) and a log row to curate. KILL each.
        await engine.dispatch({ statement: editStmt(urlSession("workspace:///scratch"), "note"), workspaceId, sessionId, loopId, turnId: curationTurn, sequence: 1, origin: "model" });
        // KILL the log EDIT row just written (active-context curation).
        const logKill = await engine.dispatch({ statement: killStmt(urlLog("log:///1/3/1/EDIT")), workspaceId, sessionId, loopId, turnId: curationTurn, sequence: 2, origin: "model" });
        assert.ok(logKill.status < 400, `KILL of the log item succeeds — got ${logKill.status}`);
        // KILL the workspace:/// note (a WORKSPACE mutation, not log housekeeping).
        const noteKill = await engine.dispatch({ statement: killStmt(urlSession("workspace:///scratch")), workspaceId, sessionId, loopId, turnId: curationTurn, sequence: 3, origin: "model" });
        assert.ok(noteKill.status < 400, `KILL of the note succeeds — got ${noteKill.status}`);

        const killCount = await db.test_count_op.get<{ n: number }>({ op: "KILL" });
        assert.ok((killCount?.n ?? 0) >= 2, "both KILLs are recorded in the DB (forensics)");

        const rendered = await db.engine_render_log.all<{ op: string; scheme: string | null }>({ session_id: sessionId });
        const killRows = rendered.filter((r) => r.op === "KILL");
        assert.ok(!killRows.some((r) => r.scheme === "log"), "the successful log-item KILL is absent immediately");
        assert.ok(killRows.some((r) => r.scheme === "workspace"), "the KILL of the session:// note — a workspace mutation — renders");
        const next = await db.engine_next_turn_sequence.get<{ next: number }>({ loop_id: loopId });
        const laterTurn = await insertTurn(db, loopId, next!.next, 102);
        await engine.dispatch({ statement: editStmt(urlSession("workspace:///scratch3"), "later"), workspaceId, sessionId, loopId, turnId: laterTurn, sequence: 1, origin: "model" });
        const later = (await db.engine_render_log.all<{ op: string; scheme: string | null }>({ session_id: sessionId })).filter((r) => r.op === "KILL");
        assert.ok(!later.some((r) => r.scheme === "log"), "the log-item KILL receipt remains absent on later turns");
        assert.ok(later.some((r) => r.scheme === "workspace"), "the workspace-mutation KILL stays visible");
    } finally { await db.close(); }
});
