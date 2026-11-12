import assert from "node:assert/strict";
import test, { describe, type TestContext } from "node:test";
import Engine from "../../src/core/Engine.ts";
import ChannelWrite from "../../src/core/ChannelWrite.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import { loopOutcome } from "../../src/core/LoopOutcome.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import StrikeRail from "../../src/core/StrikeRail.ts";
import Results from "../../src/core/results.ts";
import DispatchAsPlurnk from "../../src/server/dispatch-as-plurnk.ts";
import { type ParsedPath, isExecutionOp } from "@plurnk/plurnk-contracts";
import { Mock } from "@plurnk/plurnk-providers";
import { DEFAULT_MIMETYPES } from "./_scheme.ts";
import { insertLoop, insertSession, insertWorkspace, openMigrated, seedEntryWithChannel } from "./_db.ts";
import { lastReply } from "./_packet.ts";
import { completeStmt, noteStmt, sendStmt, urlPath, execStmt, killStmt, dispositionStmt, readStmt } from "./_dsl.ts";
import { connect, rpcCall, withDaemon, runLoopToTerminal, subscribeNotifications, waitForDb, waitFor } from "./_rpc.ts";
import { makeMockResponse, makeRawMockResponse } from "./_mock.ts";
import { serverProposals } from "./_approval.ts";
import { hostname } from "node:os";
import { viableWindow } from "./_provider.ts";
import { type Db } from "../../src/core/Db.ts";

describe("completion-defers-to-results", () => {
const response = (...program: string[]) => ({ assistant: { content: program.join("\n\n"), reasoning: null } });
const fixture = async (t: TestContext) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, `observe-${crypto.randomUUID()}`);
    const sessionId = await insertSession(db, workspaceId, null, "alice");
    const loopId = await insertLoop(db, sessionId, 1, "Report the saved answer.");
    await seedEntryWithChannel(db, {
        workspaceId, scheme: "workspace", pathname: "/answer.md", channel: "body",
        content: "The answer is 42.", mimetype: "text/markdown", state: "static",
    });
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES,
        cancelSession: async (id, reason) => { await new LoopLifecycle(db).cancelTree(id, reason, true); },
    });
    return { db, workspaceId, sessionId, loopId, engine };
};

for (const [op, maxStrikes] of [["read (workspace:///answer.md)", 0], ["read (workspace:///answer.md)", 1],
    ["read (workspace:///answer.md)", 3], ["find (workspace:///answer.md)", 3], ["bare", 3]] as const) {
    test(`{§loop-completion} ${op}, tolerance ${maxStrikes}: observe the result without repeating the answer`, async (t) => {
        const { db, engine, workspaceId, sessionId, loopId } = await fixture(t);
        const firstStmt = op === "bare"
            ? 'await plurnk.bare({"prompt":"What is six times seven?"});'
            : `await plurnk.${op.split(" ")[0].toLowerCase()}({"path":"workspace:///answer.md"});`;
        const provider = new Mock({ contextWindow: 100000, responses: [
            response(firstStmt, "await plurnk.send({\"text\":\"The answer is 42.\"});"),
            response("await plurnk.done({});"),
        ] });
        const childProvider = new Mock({ contextWindow: 100000, responses: [response("42")] });
        const result = await engine.runLoop({ provider, childProvider, workspaceId, sessionId, loopId, messages: [], maxTurns: 3, maxStrikes });
        assert.equal(result.result.status, 200);
        assert.equal(result.result.content, undefined);
        assert.equal(await lastReply(db, loopId), "The answer is 42.");
        assert.equal(provider.received.length, 2);
        assert.match(JSON.stringify(provider.received[1]), /42/, "the observation packet contains the result");
        const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; status_rx: number; tx: string }>({ loop_id: loopId });
        const authored = rows.filter(({ origin }) => origin === "model");
        assert.deepEqual(authored.map((row) => row.op), [op.split(" ")[0], "send", "done"], "the model resolves its messages without repeating the answer");
        assert.equal(authored.find((row) => row.op === "send")?.status_rx, 200, "reply delivery is not deferred");
        assert.equal(await new StrikeRail(db).streak(loopId), 0);
        const turns = await Promise.all(result.turnIds.slice(1).map((id) => db.test_get_turn.get<{ status: number }>({ id })));
        assert.deepEqual(turns.map((turn) => turn?.status), [102, 200]);
    });
}

test("{§message-completion} observation permits a corrected reply", async (t) => {
    const { db, engine, workspaceId, sessionId, loopId } = await fixture(t);
    const provider = new Mock({ contextWindow: 100000, responses: [
        response("await plurnk.read({\"path\":\"workspace:///answer.md\"});", "await plurnk.send({\"text\":\"The answer is 41.\"});"),
        response("await plurnk.done({\"text\":\"Correction: the answer is 42.\"});"),
    ] });
    const result = await engine.runLoop({ provider, workspaceId, sessionId, loopId, messages: [], maxTurns: 3 });
    assert.equal(result.result.status, 200);
    assert.equal(result.result.content, undefined);
    assert.equal(await lastReply(db, loopId), "Correction: the answer is 42.");
    const history = await db.message_history.all<{ direction: string; body: string }>({ workspace_id: workspaceId, session_id: sessionId, loop_id: loopId });
    assert.deepEqual(history.filter(({ direction }) => direction === "outbound").map(({ body }) => body), ["The answer is 41.", "Correction: the answer is 42."]);
});

for (const target of ["log:///999/*/*", "workspace:///answer.md"]) {
    test(`{§message-completion} progress SEND plus successful KILL ${target} leaves the message unresolved`, async (t) => {
        const { engine, workspaceId, sessionId, loopId } = await fixture(t);
        const provider = new Mock({ contextWindow: 100000, responses: [
            response(`await plurnk.kill({"path":"${target}"});`, "await plurnk.send({\"text\":\"Finished.\"});"),
            response("await plurnk.done({});"),
        ] });
        const result = await engine.runLoop({ provider, workspaceId, sessionId, loopId, messages: [], maxTurns: 2 });
        assert.equal(result.result.status, 200);
        assert.equal(provider.received.length, 2);
    });
}

test("{§loop-completion} curation cannot turn a same-turn READ into an observed result", async (t) => {
    const { engine, workspaceId, sessionId, loopId } = await fixture(t);
    const provider = new Mock({ contextWindow: 100000, responses: [response(
        "await plurnk.read({\"path\":\"workspace:///answer.md\"});", "await plurnk.kill({\"path\":\"log:///**/read\"});", "await plurnk.send({\"text\":\"Finished.\"});",
    )] });
    const turn = await engine.runTurn({ provider, workspaceId, sessionId, loopId, messages: [] });
    assert.equal(turn.status, 102);
    assert.deepEqual(turn.outcomes.map(({ op }) => op), ["read", "kill", "send"]);
    assert.ok(turn.outcomes.filter(({ op }) => op !== "kill").every(({ status }) => status === 200));
});

test("{§loop-completion} repeated work costs observations, not ceremony strikes", async (t) => {
    const { db, engine, workspaceId, sessionId, loopId } = await fixture(t);
    const provider = new Mock({ contextWindow: 100000, responses: [
        response("await plurnk.read({\"path\":\"workspace:///answer.md\"});", "await plurnk.send({\"text\":\"The answer is 42.\"});"),
        response("await plurnk.find({\"path\":\"workspace:///answer.md\"});"),
        response("await plurnk.done({});"),
    ] });
    const result = await engine.runLoop({ provider, workspaceId, sessionId, loopId, messages: [], maxTurns: 4, maxStrikes: 1 });
    assert.equal(result.result.status, 200);
    assert.equal(provider.received.length, 3);
    assert.equal(await new StrikeRail(db).streak(loopId), 0);
});

for (const kind of ["sessions", "streams", "failed-stream-results", "late-failed-stream-results", "session-results", "operation-failure", "kill-failure"] as const) {
    test(`{§loop-completion} ${kind} arriving after packet assembly prevents premature conclusion`, async (t) => {
        const { db, engine, workspaceId, sessionId, loopId } = await fixture(t);
        const live = kind === "sessions" || kind === "streams";
        const operation = kind === "operation-failure"
            ? 'await plurnk.read({"path":"workspace:///missing.md"});'
            : kind === "kill-failure"
                ? 'await plurnk.kill({"path":"workspace:///missing.md"});'
                : "await plurnk.done({});";
        const provider = new Mock({ contextWindow: 100000, responses: [
            response("await plurnk.read({\"path\":\"workspace:///answer.md\"});", "await plurnk.send({\"text\":\"The answer is 42.\"});"),
            response(operation), response(operation === "await plurnk.done({});" ? "" : "await plurnk.done({});"),
        ] });
        const generate = provider.generate.bind(provider);
        t.mock.method(provider, "generate", async (args: Parameters<Mock["generate"]>[0]) => {
            if (provider.received.length === 1) {
                if (kind === "sessions" || kind === "session-results") {
                    const child = await insertSession(db, workspaceId, sessionId, "child");
                    const childLoop = await insertLoop(db, child, 1, "Delegated work.");
                    if (kind === "session-results") await new LoopLifecycle(db).finish(childLoop, { status: 200, content: "Child result", mimetype: "text/plain" });
                } else if (["streams", "failed-stream-results", "late-failed-stream-results"].includes(kind)) {
                    const count = kind === "late-failed-stream-results" ? 9 : 1;
                    for (let index = 0; index < count; index++) {
                        const path = `/stream-${index}`;
                        const entryId = await seedEntryWithChannel(db, { workspaceId, authority: "alice", scheme: "session", pathname: path,
                            channel: "stdout", content: "Working", mimetype: "text/plain", state: "active" });
                        const subscriptionId = await ChannelWrite.openSubscription(db, { sessionId, entryId, scheme: "session", handle: path, publishedChannel: "stdout" });
                        if (kind !== "streams") await ChannelWrite.closeSubscription(db, { subscriptionId,
                            result: index === count - 1 ? Results.failure("executor:fixture", "failed", 500, "Fixture stream failed.") : { status: 200 },
                        });
                    }
                }
            }
            return generate(args);
        });
        const result = await engine.runLoop({ provider, workspaceId, sessionId, loopId, messages: [], maxTurns: 5 });
        assert.equal(result.result.status, live ? 202 : 200);
        assert.equal(provider.received.length, live ? 2 : 3);
        if (!live) assert.match(JSON.stringify(provider.received[2]), kind === "session-results" ? /Child result/ : kind.endsWith("stream-results") ? /Fixture stream failed/ : /404/);
        const turns = await Promise.all(result.turnIds.slice(1).map((id) => db.test_get_turn.get<{ status: number }>({ id })));
        assert.deepEqual(turns.map((turn) => turn?.status), live ? [102, 202] : [102, 102, 200]);
    });
}

test("{§session-causal-admission} explicit scope cancellation does not wait for result observation", async (t) => {
    const { engine, db, workspaceId, sessionId, loopId } = await fixture(t);
    const childId = await insertSession(db, workspaceId, sessionId, "child");
    const childLoop = await insertLoop(db, childId, 1, "Still working.");
    const provider = new Mock({ contextWindow: 100000, responses: [response("await plurnk.read({\"path\":\"workspace:///missing.md\"});",
        "await plurnk.send({\"text\":\"Stopping the work.\"});", "await plurnk.kill({\"path\":\"session://alice\"});")] });
    const result = await engine.runLoop({ provider, workspaceId, sessionId, loopId, messages: [], maxTurns: 2 });
    assert.equal(result.result.status, 499);
    assert.equal(result.result.content, undefined);
    assert.equal(await lastReply(db, loopId), "Stopping the work.");
    assert.equal(await new LoopLifecycle(db).status(childLoop), 499);
    assert.equal(provider.received.length, 1);
});
});

describe("premature-terminate-child", () => {
// {§loop-completion} extended to child sessions — completion while a spawned child is still
// live is premature exactly as completion with an open stream is (children and streams are the same
// kind of "live thing the session holds", {§session-loop-lifecycle}). Engine-level A/B so it's race-free.

const knownPath = (pathname: string): ParsedPath => ({
    kind: "url", raw: `workspace:///${pathname}`, scheme: "workspace",
    username: null, password: null, hostname: null, port: null, pathname, query: null, fragment: null,
});

test("{§loop-completion} completion with a live child session joins it on the record (no erasure), never a strike", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `prem-child-${crypto.randomUUID()}`);
        const parentSession = await insertSession(db, workspaceId);
        const parentLoop = await insertLoop(db, parentSession, 1, "parent");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const send200 = (loopId: number) => engine.runTurn({
            provider: new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [completeStmt("Complete.")] } }] }),
            workspaceId, sessionId: parentSession, loopId,
            messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }],
        });

        // Baseline: no child → completed inventory can conclude.
        const clean = await send200(parentLoop);
        assert.equal(clean.status, 200, "with no live child, completed inventory terminates cleanly");

        // Spawn a live child session (parent_session_id = parentSession, a non-terminal loop — default status 102).
        const childSession = await insertSession(db, workspaceId, parentSession);
        await insertLoop(db, childSession, 1, "child");

        // Completion over a live child is a join ({§loop-completion}): the loop parks.
        const joiningLoop = await insertLoop(db, parentSession, 2, "parent again");
        const premature = await send200(joiningLoop);
        assert.equal(premature.status, 202, "the completion joins the live child: the loop parks, it never went terminal");

        const rows = await db.test_log_entries_by_turn.all<{ status_rx: number; op: string; origin: string }>({ turn_id: premature.turnId });
        const modelRows = rows.filter(({ origin }) => origin === "model");
        const completion = modelRows.find((r) => r.op === "done");
        assert.deepEqual(modelRows.map(({ op }) => op), ["done"], "joining adds no fictional operation");
        assert.equal(completion?.status_rx, 200, "the reply is delivered while the loop joins the child");
    } finally { await db.close(); }
});

test("{§loop-completion} an _plurnk administrative completion closes only its own loop while model work remains live", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `admin-terminal-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const modelLoopId = await insertLoop(db, sessionId, 1, "model work");
        const childSessionId = await insertSession(db, workspaceId, sessionId);
        const childLoopId = await insertLoop(db, childSessionId, 1, "child work");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        await DispatchAsPlurnk.dispatch(engine, db, workspaceId, sessionId, [noteStmt("Maintenance.")]);
        const loops = await db.test_loop_queue_by_session.all<{ id: number; status: number }>({ session_id: sessionId });
        assert.ok(loops.some(({ id, status }) => id !== modelLoopId && status === 200),
            "the administrative transaction closes despite unrelated model work");
        assert.equal((await db.test_get_loop_status.get<{ status: number }>({ id: modelLoopId }))?.status, 102, "the model loop remains live");
        assert.equal((await db.test_get_loop_status.get<{ status: number }>({ id: childLoopId }))?.status, 102, "the child obligation remains live");
    } finally { await db.close(); }
});

test("{§loop-completion} a newer terminal loop cannot mask a child's older unresolved work", async () => {
    // A real fork clamps inherited loops terminal before creating its own work.
    // This deliberately inconsistent fixture proves that every unresolved loop
    // remains a live obligation regardless of newer history.
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `prem-concluded-${crypto.randomUUID()}`);
        const parentSession = await insertSession(db, workspaceId);
        const parentLoop = await insertLoop(db, parentSession, 1, "parent");
        const childSession = await insertSession(db, workspaceId, parentSession);
        const unresolvedLoop = await insertLoop(db, childSession, 1, "unresolved");
        const ownLoop = await insertLoop(db, childSession, 2, "own work");        // seq 2 — the child's actual loop
        await db.test_set_loop_status.run({
            id: ownLoop,
            status: 200,
            terminal_result: JSON.stringify({ status: 200 }),
        }); // it concluded

        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const refused = await engine.runTurn({
            provider: new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [completeStmt("Complete.")] } }] }),
            workspaceId, sessionId: parentSession, loopId: parentLoop,
            messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }],
        });
        assert.equal(refused.status, 202, "the older unresolved loop keeps the child live: the completion joins it");

        await db.test_set_loop_status.run({
            id: unresolvedLoop,
            status: 200,
            terminal_result: JSON.stringify({ status: 200 }),
        });
        await new LoopLifecycle(db).wake(parentLoop);
        assert.equal((await db.drain_claim_next_loop.get<{ id: number }>({ session_id: parentSession }))?.id, parentLoop);
        const completed = await engine.runTurn({
            provider: new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null } }] }),
            workspaceId, sessionId: parentSession, loopId: parentLoop,
            messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }],
        });
        assert.equal(completed.status, 200, "completion succeeds only after every child loop is terminal");
    } finally { await db.close(); }
});

// {§loop-completion}: settlement follows the entire admitted program.

test("{§loop-completion}: READ + completed inventory in the same turn is deferred — the pending set includes this turn's retrievals", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `pend-read-${crypto.randomUUID()}`);
        const parentSession = await insertSession(db, workspaceId);
        const parentLoop = await insertLoop(db, parentSession, 1, "parent");
        await seedEntryWithChannel(db, { workspaceId, scheme: "workspace", pathname: "/config.json", channel: "body", content: '{"host":"db.internal"}', mimetype: "application/json", state: "static" });
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const result = await engine.runTurn({
            provider: new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [readStmt(knownPath("/config.json")), sendStmt(null, "the host is db.internal")] } }] }),
            workspaceId, sessionId: parentSession, loopId: parentLoop,
            messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }],
        });
        assert.equal(result.status, 102, "the turn stays a continue — the loop never went terminal");
        const rows = await db.test_log_sequencees_by_turn.all<{ status_rx: number; op: string }>({ turn_id: result.turnId });
        assert.equal(rows.find((r) => r.op === "send")?.status_rx, 200, "successful delivery is not rewritten to describe loop continuation");
        // The STORED record agrees with the return: the close persists the provisional status
        // pre-dispatch, and the refusal demotes the stored row too.
        const storedTurn = await db.test_get_turn.get<{ status: number }>({ id: result.turnId });
        assert.equal(storedTurn?.status, 102, "the persisted turns.status is demoted — the digest surface never lies");
    } finally { await db.close(); }
});

test("{§op-shapes} WAIT ignores a non-duration decoration and continues without live work", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `park-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "wait");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const result = await engine.runTurn({
            provider: new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "await plurnk.wait({\"text\":\"standing by\"});", reasoning: null } }] }),
            workspaceId, sessionId, loopId,
            messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }],
        });
        assert.equal(result.status, 102);
        const loopStatus = (await db.test_get_loop_status.get<{ status: number }>({ id: loopId }))?.status;
        assert.equal(loopStatus, 102, "an ignored scope does not invent a future wake");
        const row = await db.test_disposition_rows_for_session.all<{ status_rx: number; rx: string }>({ session_id: sessionId });
        assert.equal(row.length, 1);
        assert.equal(row[0].status_rx, 102);
        assert.equal(JSON.parse(row[0].rx).problem, undefined);
        assert.equal(JSON.parse(row[0].rx).detail, "Nothing is in flight. Continuing."); // {§operation-results}
    } finally { await db.close(); }
});

test("{§op-shapes} a decorated WAIT keeps its sibling, source evidence, and ordinary result", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `next-scope-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "read the note");
        await seedEntryWithChannel(db, { workspaceId, scheme: "workspace", pathname: "/note.txt", channel: "body", content: "the note", mimetype: "text/plain", state: "static" });
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const content = "await plurnk.read({\"path\":\"workspace:///note.txt\"});\n\nawait plurnk.wait({\"target\":\"sh:///missing\",\"seconds\":60,\"text\":\"standing by\"});";
        const result = await engine.runTurn({
            provider: new Mock({ contextWindow: 100000, responses: [{ assistant: { content, reasoning: null } }] }),
            workspaceId, sessionId, loopId,
            messages: [{ role: "user", content: "read the note" }],
        });
        assert.equal(result.status, 102);
        const rows = await db.test_log_entries_by_turn.all<{ op: string | null; status_rx: number; rx: string }>({ turn_id: result.turnId });
        assert.equal(rows.find(({ op }) => op === "read")?.status_rx, 200, "the valid sibling executes");
        assert.equal(rows.some(({ op }) => op === "error"), false);
        const task = rows.find(({ op }) => op === "wait");
        assert.equal(task?.status_rx, 102);
        assert.equal(JSON.parse(task.rx).problem, undefined);
        assert.equal(JSON.parse(task.rx).detail, "Nothing is in flight. Continuing."); // {§operation-results}
        const packet = await db.test_get_packet.get<{ packet: string }>({ id: result.turnId });
        assert.ok(packet);
        assert.equal(JSON.parse(packet.packet).assistant.content, content);
        const attempts = await db.test_turn_attempts.all<{ accepted: number; parse_errors: string }>({ turn_id: result.turnId });
        assert.equal(attempts[0]?.accepted, 1);
        const diagnostics = JSON.parse(attempts[0].parse_errors) as Array<{ message: string }>;
        assert.deepEqual(diagnostics, []);
        assert.equal((await db.test_get_loop_status.get<{ status: number }>({ id: loopId }))?.status, 102);
    } finally { await db.close(); }
});

test("{§loop-completion} waiting cannot complete an empty join over a same-turn failed operation", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `join-failure-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "wait");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const result = await engine.runTurn({
            provider: new Mock({
                contextWindow: 100000,
                responses: [{
                    assistant: {
                        content: "",
                        reasoning: null,
                        ops: [
                            execStmt("unregistered-runtime", "build"),
                            dispositionStmt("wait", "awaiting the build"),
                        ],
                    },
                }],
            }),
            workspaceId,
            sessionId,
            loopId,
            messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }],
        });

        assert.equal(result.status, 102, "the failed operation remains unobserved, so the turn continues");
        const loopStatus = (await db.test_get_loop_status.get<{ status: number }>({ id: loopId }))?.status;
        assert.equal(loopStatus, 102, "the loop never records a false successful terminal");
        const rows = await db.test_log_sequencees_by_turn.all<{ status_rx: number; op: string }>({ turn_id: result.turnId });
        assert.ok((rows.find((row) => isExecutionOp(row.op))?.status_rx ?? 0) >= 400, "the original operation failure is preserved");
        assert.equal(rows.find((row) => row.op === "wait")?.status_rx, 102, "the failed result enters the next packet without an additional correction");
    } finally { await db.close(); }
});

test("{§loop-completion} a successful same-turn scoped KILL continues an empty wait and permits explicit completion", async () => {
    const db = await openMigrated();
    try {
        const run = async (status: 200 | 202) => {
            const workspaceId = await insertWorkspace(db, `fold-disposition-${status}-${crypto.randomUUID()}`);
            const sessionId = await insertSession(db, workspaceId);
            const loopId = await insertLoop(db, sessionId, 1, "curate");
            await seedEntryWithChannel(db, {
                workspaceId,
                scheme: "workspace",
                pathname: "/notes.md",
                channel: "body",
                content: "context to curate",
                mimetype: "text/markdown",
                state: "static",
            });
            const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
            const primed = await engine.runTurn({
                provider: new Mock({
                    contextWindow: 100000,
                    responses: [{ assistant: { content: "", reasoning: null, ops: [readStmt(knownPath("/notes.md")), noteStmt("Continue.")] } }],
                }),
                workspaceId,
                sessionId,
                loopId,
                messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }],
            });
            const rows = await db.test_log_sequencees_by_turn.all<{ sequence: number; op: string }>({ turn_id: primed.turnId });
            const read = rows.find((row) => row.op === "read");
            assert.ok(read, "the prior READ provides one open log row to curate");
            const primedTurn = await db.test_get_turn.get<{ sequence: number }>({ id: primed.turnId });
            assert.ok(primedTurn, "the model turn has a durable loop coordinate");
            const result = await engine.runTurn({
                provider: new Mock({
                    contextWindow: 100000,
                    responses: [{
                        assistant: {
                            content: "",
                            reasoning: null,
                            ops: [
                                killStmt(urlPath("log", `/1/${primedTurn.sequence}/${read.sequence}/read`), { marks: [1, -1] }),
                                status === 202 ? dispositionStmt("wait", "continue after curation") : sendStmt(null, "curation complete"),
                            ],
                        },
                    }],
                }),
                workspaceId,
                sessionId,
                loopId,
                messages: [{ role: "system", content: "SD" }, { role: "user", content: "continue" }],
            });
            return { loopId, result };
        };

        const continued = await run(202);
        assert.equal(continued.result.status, 102, "log curation makes the next packet meaningful, so an empty wait continues");
        assert.equal(
            (await db.test_get_loop_status.get<{ status: number }>({ id: continued.loopId }))?.status,
            102,
            "the curated loop remains available for its next reasoning turn",
        );

        const concluded = await run(200);
        assert.equal(concluded.result.status, 102, "curation executes, but a progress SEND leaves the message unresolved");
    } finally { await db.close(); }
});

test("{§loop-completion} a READ with a NOTE continues while its message remains unanswered", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `prem-read-ok-${crypto.randomUUID()}`);
        const parentSession = await insertSession(db, workspaceId);
        const parentLoop = await insertLoop(db, parentSession, 1, "parent");
        await seedEntryWithChannel(db, { workspaceId, scheme: "workspace", pathname: "/config.json", channel: "body", content: '{"host":"db.internal"}', mimetype: "application/json", state: "static" });
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const result = await engine.runTurn({
            provider: new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [readStmt(knownPath("/config.json")), noteStmt("Continue.")] } }] }),
            workspaceId, sessionId: parentSession, loopId: parentLoop,
            messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }],
        });
        assert.equal(result.status, 102, "READ with a NOTE does not answer the assignment");
    } finally { await db.close(); }
});

test("{§loop-completion} a model declaring done with a live child parks on the first claim: no false 200, no spin", async () => {
    // The 200-vs-202 robustness: a model that declares done while its child works is joined to that
    // work — the loop parks and the wake brings the result — so it can never falsely complete, and it
    // never spins through turns claiming done.
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `prem-strike-${crypto.randomUUID()}`);
        const parentSession = await insertSession(db, workspaceId);
        const parentLoop = await insertLoop(db, parentSession, 1, "parent");
        // A persistently live child (its loop stays non-terminal through the parent's whole loop).
        const childSession = await insertSession(db, workspaceId, parentSession);
        await insertLoop(db, childSession, 1, "child");
        const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
        const provider = new Mock({ contextWindow: 100000, responses: Array.from({ length: 6 }, () => ({ assistant: { content: "", reasoning: null, ops: [completeStmt("Complete.")] } })) });
        const result = await engine.runLoop({ provider, workspaceId, sessionId: parentSession, loopId: parentLoop, messages: [], maxTurns: 10, maxStrikes: 3 });
        assert.equal(result.result.status, 202, "the first claim joins the live child: the loop parks");
        assert.equal(provider.received.length, 1, "no further turn runs until the child concludes and wakes the loop");
        assert.notEqual(result.result.status, 200, "a model declaring done with work running NEVER gets a false 200");
    } finally { await db.close(); }
});

test("{§loop-completion} 499 is never gated by live work: it recursively cancels unresolved descendants", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `guard-499-${crypto.randomUUID()}`);
        const parentSession = await insertSession(db, workspaceId);
        const parentLoop = await insertLoop(db, parentSession, 1, "parent");
        const childSession = await insertSession(db, workspaceId, parentSession);
        const childLoop = await insertLoop(db, childSession, 1, "child"); // live child
        await seedEntryWithChannel(db, { workspaceId, scheme: "workspace", pathname: "/config.json", channel: "body", content: '{"host":"x"}', mimetype: "application/json", state: "static" });
        const lifecycle = new LoopLifecycle(db);
        const engine = new Engine({
            db,
            schemes: new SchemeRegistry(),
            mimetypes: DEFAULT_MIMETYPES,
            cancelSession: async (root, reason) => { await lifecycle.cancelTree(root, reason, true); },
        });
        const parent = await db.envelope_get_session_by_id.get<{ name: string }>({ id: parentSession });
        assert.ok(parent);
        const result = await engine.runTurn({
            provider: new Mock({ contextWindow: 100000, responses: [{ assistant: { content: "", reasoning: null, ops: [killStmt({ ...urlPath("session", ""), hostname: parent.name, raw: `session://${parent.name}` })] } }] }),
            workspaceId, sessionId: parentSession, loopId: parentLoop,
            messages: [{ role: "system", content: "SD" }, { role: "user", content: "go" }],
        });
        assert.equal(result.status, 499, "the abandon lands — live work never gates a 499 ({§loop-completion} defers only settled results)");
        const loopStatus = (await db.test_get_loop_status.get<{ status: number }>({ id: parentLoop }))?.status;
        assert.equal(loopStatus, 499, "the loop is terminal");
        const childStatus = (await db.test_get_loop_status.get<{ status: number }>({ id: childLoop }))?.status;
        assert.equal(childStatus, 499, "the unresolved child is cancelled with its abandoned parent scope");
        const rows = await db.test_log_entries_by_turn.all<{ op: string; status_rx: number; origin: string }>({ turn_id: result.turnId });
        assert.deepEqual(rows.filter(({ origin }) => origin === "model").map(({ op, status_rx }) => [op, status_rx]), [["kill", 200]],
            "cancellation is the actual KILL, not an invented failure operation");
    } finally { await db.close(); }
});
});

describe("send-200-mutation-receipts", () => {
for (const curate of [false, true]) {
    test(`{§loop-completion}: mutation receipts require observation, including when curated=${curate}`, async (approvalContext) => {
    serverProposals(approvalContext, "accept");
        const extra = curate ? "await plurnk.read({\"path\":\"workspace:///notes.md\"});\n\nawait plurnk.read({\"path\":\"workspace:///notes.md\"});\n\nawait plurnk.kill({\"path\":\"log:///**/edit\"});" : "";
        const mock = new Mock({ contextWindow: 16384, responses: [
            makeMockResponse("await plurnk.edit({\"path\":\"workspace:///notes.md\",\"content\":\"hello\"});" + extra + "await plurnk.send({\"text\":\"Written.\"});"),
            makeMockResponse("await plurnk.done({});"),
        ] });
        await withDaemon(mock, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "mutation-gate" });
                const result = await runLoopToTerminal(ws, 2, { prompt: "go" });
                assert.equal(result.finalStatus, 200);
                assert.equal(result.result.content, undefined);
        assert.equal(await lastReply(db, result.loopId), "Written.");
                assert.equal(mock.received.length, 2, "a completed mutation needs one observation turn, no terminal ceremony");
                const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; status_rx: number }>({ loop_id: result.loopId });
                const model = rows.filter(({ origin }) => origin === "model");
                assert.deepEqual(model.map(({ op }) => op), curate ? ["edit", "read", "read", "kill", "send", "done"] : ["edit", "send", "done"]);
                assert.equal(model[0].status_rx, 201);
                assert.deepEqual(model.slice(1).map(({ op, status_rx }) => [op, status_rx]),
                    curate ? [["read", 200], ["read", 200], ["kill", 204], ["send", 200], ["done", 200]] : [["send", 200], ["done", 200]],
                    "curation cannot select a same-turn receipt before it is published");
                assert.match(JSON.stringify(mock.received[1]), /notes\.md/);
                const entry = await db.test_get_channel_by_pathname_scheme.get<{ content: string }>({ pathname: "/notes.md", scheme: "workspace", name: "body" });
                assert.equal(entry?.content, "hello", "both creation and retained content are verified");
            } finally { ws.close(); }
        });
    });
}
});

describe("send-200-stream-success", () => {
// {§loop-completion} {§message-completion}

const withSettlement = async (ms: string, fn: () => Promise<void>): Promise<void> => {
    const previous = process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
    process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = ms;
    try {
        await fn();
    } finally {
        if (previous === undefined) delete process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
        else process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = previous;
    }
};

for (const command of ["true", "hostname"]) {
    for (const earlyReply of [false, true]) test(`{§loop-completion} a successful ${command} reaches the next packet, early reply=${earlyReply}`, async (approvalContext) => {
    serverProposals(approvalContext, "accept");
        const answer = command === "hostname" ? hostname() : "The command completed successfully.";
        const reply = earlyReply ? "await plurnk.send({\"text\":\"The hostname is plurnk-sandbox.\"});" : "";
        const provider = new Mock({
            contextWindow: 100_000,
            responses: [
                makeMockResponse(`await plurnk.sh({"command":"${command}"});\n${reply}`),
                makeMockResponse(`await plurnk.done({"text":"${answer}"});`),
            ],
        });
        await withSettlement("3000", () => withDaemon(provider, async (db, _daemon, addr) => {
            const ws = await connect(addr);
            try {
                await rpcCall(ws, 1, "workspace.create", { name: "stream-success-terminal" });
                const result = await runLoopToTerminal(ws, 2, { prompt: "submit, then conclude" });
                assert.equal(result.finalStatus, 200);
                assert.equal(provider.remaining, 0, "the model gets exactly one observation turn before completing");
                assert.equal(provider.received.length, 2);
                assert.equal(result.result.content, undefined);
        assert.equal(await lastReply(db, result.loopId), answer, "the corrected answer is the response; the blind first SEND stays a log row");
                const observedPacket = JSON.stringify(provider.received[1]);
                assert.match(observedPacket, /terminal/, "the next packet contains the stream conclusion");
                if (command === "hostname") assert.ok(observedPacket.includes(hostname()), "the actual hostname reaches the model");
                const rows = await db.test_log_entries_by_session.all<{ op: string; origin: string; status_rx: number }>({ session_id: result.modelSessionId });
                assert.ok(rows.some((r) => isExecutionOp(r.op)), "the stream ran");
                assert.deepEqual(rows.filter(({ origin }) => origin === "model").map(({ op }) => op),
                    ["sh", ...(earlyReply ? ["send"] : []), "done"], "no synthetic completion operation");
                assert.equal(rows.filter((r) => (r.op === "send" || r.op === "done") && r.origin === "model" && r.status_rx === 200).length,
                    earlyReply ? 2 : 1, "only the authored replies were delivered");
            } finally {
                ws.close();
            }
        }));
    });
}

test("{§loop-completion}: a successful execution receipt defers completion one packet without a strike", async (t) => {
    serverProposals(t, "accept");
    const previous = process.env.PLURNK_SERVICE_MAX_STRIKES;
    process.env.PLURNK_SERVICE_MAX_STRIKES = "1";
    t.after(() => {
        if (previous === undefined) delete process.env.PLURNK_SERVICE_MAX_STRIKES;
        else process.env.PLURNK_SERVICE_MAX_STRIKES = previous;
    });
    const provider = new Mock({
        contextWindow: 100_000,
        responses: [
            makeMockResponse("await plurnk.sh({\"command\":\"true\"});\n\nawait plurnk.send({\"text\":\"Completed.\"});"),
            makeMockResponse("await plurnk.done({});"),
        ],
    });
    await withSettlement("3000", () => withDaemon(provider, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "stream-final-strike" });
            const result = await runLoopToTerminal(ws, 2, { prompt: "run the command" });
            assert.equal(result.finalStatus, 200, "the deferred completion concludes on the next packet; at MAX_STRIKES 1 a strike would have ended the loop");
            assert.equal(provider.received.length, 2);
            assert.equal(provider.remaining, 0);
            const rows = await db.test_log_entries_by_session.all<{ op: string; origin: string; status_rx: number }>({ session_id: result.modelSessionId });
            assert.deepEqual(rows.filter(({ origin }) => origin === "model").map(({ op }) => op), ["sh", "send", "done"]);
            assert.equal(result.result.content, undefined);
            assert.equal(await lastReply(db, result.loopId), "Completed.", "an empty completion resolves the observed assignment without repeating its answer");
            assert.equal(rows.filter(({ op, origin }) => isExecutionOp(op) && origin === "model").length, 1, "the submitted command was executed");
        } finally {
            ws.close();
        }
    }));
});

test("{§loop-completion}: a same-turn stream's nonzero exit defers completion without echoing its command", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const provider = new Mock({
        contextWindow: 100_000,
        responses: [
            makeMockResponse("await plurnk.sh({\"command\":\"exit 3\"});\n\nawait plurnk.send({\"text\":\"concluding blind\"});"),
            makeMockResponse("await plurnk.done({\"text\":\"concluding after reading the failure\"});"),
        ],
    });
    await withSettlement("3000", () => withDaemon(provider, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "stream-failure-terminal" });
            const result = await runLoopToTerminal(ws, 2, { prompt: "submit, then conclude" });
            assert.equal(result.finalStatus, 200);
            assert.equal(provider.remaining, 0, "the deferral cost exactly one more provider turn");
            const rows = await db.test_log_entries_by_session.all<{ id: number; op: string; origin: string; status_rx: number }>({ session_id: result.modelSessionId });
            assert.deepEqual(rows.filter(({ origin }) => origin === "model").map(({ op }) => op), ["sh", "send", "done"]);
            assert.ok(rows.some(({ op, origin, status_rx }) => op === "read" && origin === "_plurnk" && status_rx === 200), "the terminal stream observation lands as the command's answer");
            assert.match(JSON.stringify(provider.received[1]), /\\"exitCode\\":3/, "the exit code reaches the observation packet");
            assert.equal(result.result.content, undefined);
        assert.equal(await lastReply(db, result.loopId), "concluding after reading the failure");
            assert.ok(rows.filter(({ origin, op }) => origin === "model" && ["send", "done", "kill"].includes(op)).every(({ status_rx }) => status_rx === 200),
                "both replies succeeded independently of the execution");
        } finally {
            ws.close();
        }
    }));
});
});

describe("session-message-obligation", () => {
// {§loop-completion} a message a session sent to another session holds the sender: its authored WAIT parks,
// and the recipient's completion, 200 or 499, wakes the same loop. {§loop-completion}: a recipient loop
// that ends without answering is answered 499 by the daemon, and that completion wakes the sender too.

type Emission = string | { raw: string };
type Step = (db: Db) => Promise<Emission> | Emission;

class Scripted extends Mock {
    readonly #scripts: Record<string, Step[]>;
    readonly #db: () => Db;
    constructor(db: () => Db, scripts: Record<string, Step[]>) {
        super({ contextWindow: viableWindow(), responses: [] });
        this.#scripts = Object.fromEntries(Object.entries(scripts).map(([name, steps]) => [name, [...steps]]));
        this.#db = db;
    }
    left(name: string): number { return this.#scripts[name]?.length ?? 0; }
    override get remaining(): number { return Object.values(this.#scripts).reduce((sum, steps) => sum + steps.length, 0); }
    override async generate(...args: Parameters<Mock["generate"]>): ReturnType<Mock["generate"]> {
        const packet = args[0].messages.map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n");
        const name = Object.keys(this.#scripts).find((candidate) => candidate !== "root" && packet.includes(`"path":"session://${candidate}","parent":`)) ?? "root";
        const step = this.#scripts[name]?.shift();
        if (step === undefined) throw new Error(`scripted provider: '${name}' asked for a turn its script does not have`);
        const emission = await step(this.#db());
        const response = typeof emission === "string" ? makeMockResponse(emission, 10) : makeRawMockResponse(emission.raw, 10);
        const once = new Mock({ contextWindow: viableWindow(), responses: [response] });
        return once.generate(...args);
    }
}

const parentOf = async (db: Db, workspaceId: number, child: string): Promise<string> => {
    const session = await waitForDb(() => db.session_resolve_by_name.get<{ id: number }>({ workspace_id: workspaceId, name: child }), (row) => row !== undefined);
    const task = await waitForDb(() => db.test_messages_by_session.all<{ ordinal: number; source: string | null }>({ session_id: session!.id }), (rows) => rows.some((row) => row.ordinal === 1));
    return task.find((row) => row.ordinal === 1)!.source!;
};

const openMessageFrom = async (db: Db, workspaceId: number, sender: string): Promise<string> => {
    const row = await waitForDb(
        () => db.test_open_message_from.get<{ path: string }>({ workspace_id: workspaceId, source: `session://${sender}` }),
        (found) => found !== undefined,
    );
    return row!.path;
};

const sessionIdOf = async (db: Db, workspaceId: number, name: string): Promise<number> =>
    (await db.session_resolve_by_name.get<{ id: number }>({ workspace_id: workspaceId, name }))!.id;

const loopsOf = async (db: Db, sessionId: number): Promise<number> =>
    (await db.test_count_loops_by_session.get<{ n: number }>({ session_id: sessionId }))!.n;

const inferenceStatuses = async (db: Db, sessionId: number): Promise<number[]> => {
    const loops = await db.test_list_loops_all.all<{ id: number; session_id: number }>({});
    const loop = loops.find((row) => row.session_id === sessionId)!;
    const turns = await db.test_list_turns_in_loop.all<{ kind: string; status: number }>({ loop_id: loop.id });
    return turns.filter((turn) => turn.kind === "inference").map((turn) => turn.status);
};

for (const [name, completion, answer] of [["answered 200", 200, "the code is 4815"], ["declined 499", 499, "no code for you"]] as const) {
    test(`{§loop-completion} a child's message to its parent holds the child's WAIT, and the parent's completion (${name}) wakes the same loop`, async (approvalContext) => {
        serverProposals(approvalContext, "accept");
        let db!: Db;
        let workspaceId = 0;
        const provider = new Scripted(() => db, {
            root: [
                () => "await plurnk.work({\"target\":\"session://kid\",\"prompt\":\"ask me for the code, then report what I said\"});\n\nawait plurnk.wait({\"text\":\"awaiting kid\"});",
                async (d) => `await plurnk.${completion === 200 ? "done" : "fail"}(${JSON.stringify({ target: await openMessageFrom(d, workspaceId, "kid"), text: answer })});

await plurnk.wait({"text":"still awaiting kid"});`,
                () => "await plurnk.done({\"text\":\"kid is done\"});",
            ],
            kid: [
                async (d) => `await plurnk.send({"target":"${await parentOf(d, workspaceId, "kid")}","text":"what is the code?"});

await plurnk.wait({"text":"awaiting the parent's answer"});`,
                () => "await plurnk.done({\"text\":\"reported\"});",
            ],
        });
        await withDaemon(provider, async (database, _daemon, addr) => {
            db = database;
            const ws = await connect(addr);
            try {
                const created = await rpcCall(ws, 1, "workspace.create", { name: `message-hold-${completion}` });
                workspaceId = (created.result as { id: number }).id;
                const terminated = subscribeNotifications(ws, "loop/terminated");
                const { finalStatus } = await runLoopToTerminal(ws, 2, { prompt: "spawn kid and answer it" });
                assert.equal(finalStatus, 200, "the parent concluded after kid reported");
                assert.equal(provider.remaining, 0, "every scripted turn of both sessions ran");
                const kid = await sessionIdOf(db, workspaceId, "kid");
                assert.equal(await loopsOf(db, kid), 1, "the completion woke kid's parked loop; no fresh loop was minted");
                assert.equal((await inferenceStatuses(db, kid))[0], 202, "kid's WAIT parked on its message to the parent, nothing else being live");
                const completed = await db.test_message_completions_from.all<{ status: number; origin: string }>({ workspace_id: workspaceId, source: "session://kid" });
                assert.deepEqual(completed.map((row) => [row.status, row.origin]), [[completion, "model"]], "the parent's reply completed kid's message as authored");
                const [kidEnded] = await waitFor(
                    () => (terminated() as Array<{ sessionId: number; result: { status: number } }>).filter((event) => event.sessionId === kid),
                    (events) => events.length > 0,
                );
                assert.equal(kidEnded.result.status, 200, "kid concluded 200 after the parent's");
            } finally { ws.close(); }
        });
    });
}

test("{§loop-completion} a parent that strikes out with the child's message unanswered: the daemon completes it 499 and the child wakes", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    let db!: Db;
    let workspaceId = 0;
    const provider = new Scripted(() => db, {
        root: [
            () => "await plurnk.work({\"target\":\"session://kid\",\"prompt\":\"ask me for the code, then report what happened\"});\n\nawait plurnk.wait({\"text\":\"awaiting kid\"});",
            ...Array.from({ length: 16 }, () => () => ({ raw: "I am thinking about the code and will answer soon." })),
        ],
        kid: [
            async (d) => `await plurnk.send({"target":"${await parentOf(d, workspaceId, "kid")}","text":"what is the code?"});

await plurnk.wait({"text":"awaiting the parent's answer"});`,
            () => "await plurnk.done({\"text\":\"the parent went away without answering\"});",
        ],
    });
    await withDaemon(provider, async (database, _daemon, addr) => {
        db = database;
        const ws = await connect(addr);
        try {
            const created = await rpcCall(ws, 1, "workspace.create", { name: "message-abandoned" });
            workspaceId = (created.result as { id: number }).id;
            const terminated = subscribeNotifications(ws, "loop/terminated");
            const { finalStatus } = await runLoopToTerminal(ws, 2, { prompt: "spawn kid and stall" });
            assert.ok(finalStatus >= 400 && finalStatus !== 499, `the parent's loop ended by its own strikes, not a cancellation; got ${finalStatus}`);
            const completed = await waitForDb(
                () => db.test_message_completions_from.all<{ status: number; origin: string }>({ workspace_id: workspaceId, source: "session://kid" }),
                (rows) => rows.length > 0,
            );
            assert.deepEqual(completed.map((row) => [row.status, row.origin]), [[499, "_plurnk"]], `the daemon completed kid's message 499 by its own hand; saw ${JSON.stringify(completed)} after the parent ended ${finalStatus}`);
            const kid = await sessionIdOf(db, workspaceId, "kid");
            const kidDone = await waitForDb(
                () => db.test_list_loops_all.all<{ status: number; session_id: number }>({}),
                (loops) => loops.some((loop) => loop.session_id === kid && loop.status === 200),
            );
            assert.ok(kidDone.length > 0);
            assert.equal(provider.left("kid"), 0, "kid woke on the 499 and reported");
            assert.equal(await loopsOf(db, kid), 1, "the same parked loop woke; none was minted");
            assert.equal((await inferenceStatuses(db, kid))[0], 202, "kid's WAIT had parked on its message");
            const [kidEnded] = await waitFor(
                () => (terminated() as Array<{ sessionId: number; result: { status: number } }>).filter((event) => event.sessionId === kid),
                (events) => events.length > 0,
            );
            assert.equal(kidEnded.result.status, 200, "kid concluded 200");
        } finally { ws.close(); }
    });
});

test("{§loop-completion} {§message-completion} a loop that fails with published acp:// messages unanswered settles them 499 and leaves subsequent loops clean", async (approvalContext) => {
    serverProposals(approvalContext, "accept");
    const scoutMsg1 = "acp://scoutproxy/sessions/1%23main/messages/m-scout-1";
    const scoutMsg2 = "acp://scoutproxy/sessions/1%23main/messages/m-scout-2";
    const provider = new Mock({
        contextWindow: 100_000,
        responses: [
            makeRawMockResponse("await plurnk.note({\"text\":\"investigating before turn ceiling\"});"),
            makeMockResponse("await plurnk.done({\"text\":\"Recovered cleanly.\"});"),
        ],
    });
    await withDaemon(provider, async (db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "acp-abandoned-settlement" });
        const { sessionId } = await daemon.createSession({ workspaceId, name: "main" });
        const first = await daemon.runLoop({
            workspaceId,
            sessionId,
            prompt: "First request before failure.",
            source: scoutMsg1,
            messageAddress: scoutMsg1,
            maxTurns: 1,
        });
        await waitForDb(
            () => daemon.listSessionLoops({ workspaceId, sessionId }),
            (loops) => loops.some(({ id, status }) => id === first.loopId && status === 429),
        );
        const completed = await waitForDb(
            () => db.test_message_completions_from.all<{ status: number; origin: string }>({
                workspace_id: workspaceId,
                source: scoutMsg1,
            }),
            (rows) => rows.length > 0,
        );
        assert.deepEqual(
            completed.map((row) => [row.status, row.origin]),
            [[499, "_plurnk"]],
            "the daemon settles the unanswered acp:// message 499 in message_completions",
        );
        assert.equal(
            (await db.message_unanswered_count.get<{ count: number }>({ loop_id: first.loopId }))?.count,
            0,
            "zero unanswered messages remain attached to the failed loop",
        );
        const loop1Outcome = await loopOutcome(db, workspaceId, "main", 1);
        assert.equal(loop1Outcome?.result.status, 429, "ops://<session>/1 retains the loop's terminal Problem rather than _plurnk abandonment text");
        const answerRow = await db.turn_source_loop_answer.get<{ answer: string | null }>({
            workspace_id: workspaceId,
            session_name: "main",
            loop_seq: 1,
        });
        assert.equal(answerRow?.answer, null, "_plurnk abandonment fail never counts as the model's loop answer");

        const second = await daemon.runLoop({
            workspaceId,
            sessionId,
            prompt: "Follow-up after quota recovery.",
            source: scoutMsg2,
            messageAddress: scoutMsg2,
        });
        await waitForDb(
            () => daemon.listSessionLoops({ workspaceId, sessionId }),
            (loops) => loops.some(({ id, status }) => id === second.loopId && status === 200),
        );
        const packet2 = JSON.stringify(provider.received[1]);
        assert.doesNotMatch(packet2, /ended with status 429; this message was not answered/, "maintenance abandonment rows stay out of model ## Log");
        assert.equal(await lastReply(db, second.loopId), "Recovered cleanly.");
    });
});
});

describe("session-obligations", () => {
test("{§loop-completion}: open non-detached streams and live children are obligations; detached streams and settled children are not", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `obligations-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId, null, "parent");
        const held = async (): Promise<{ streams: number; sessions: number }> =>
            (await db.session_live_obligations.get<{ streams: number; sessions: number }>({ session_id: sessionId }))!;
        assert.deepEqual(await held(), { streams: 0, sessions: 0 }, "a fresh session holds nothing");

        const first = await seedEntryWithChannel(db, { workspaceId, scheme: "sh", pathname: "/1/1/1/sh", channel: "stdout", content: "", state: "active" });
        const detached = await db.test_open_subscription_detached.get<{ id: number }>({ session_id: sessionId, entry_id: first, detached: 1 });
        assert.ok(detached);
        assert.deepEqual(await held(), { streams: 0, sessions: 0 }, "a detached stream outlives the loop and is nobody's obligation");
        const second = await seedEntryWithChannel(db, { workspaceId, scheme: "sh", pathname: "/1/1/2/sh", channel: "stdout", content: "", state: "active" });
        const attached = await db.test_open_subscription_detached.get<{ id: number }>({ session_id: sessionId, entry_id: second, detached: 0 });
        assert.ok(attached);
        assert.deepEqual(await held(), { streams: 1, sessions: 0 }, "an open attached stream is an obligation");
        await db.test_close_subscription.run({ id: attached.id });
        assert.deepEqual(await held(), { streams: 0, sessions: 0 }, "a settled stream is not");

        const childId = await insertSession(db, workspaceId, sessionId, "child");
        const childLoop = await insertLoop(db, childId, 1, "work");
        assert.deepEqual(await held(), { streams: 0, sessions: 1 }, "a child with an unresolved loop is an obligation");
        await db.test_set_loop_status.run({ id: childLoop, status: 200, terminal_result: JSON.stringify({ status: 200 }) });
        assert.deepEqual(await held(), { streams: 0, sessions: 0 }, "a concluded child is not");
    } finally { await db.close(); }
});
});
