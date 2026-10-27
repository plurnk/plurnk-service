import test, { describe } from "node:test";
import assert from "node:assert/strict";
import Engine from "../../src/core/Engine.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import Results from "../../src/core/results.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import LogEntryProjection from "../../src/core/LogEntryProjection.ts";
import LogBody from "../../src/core/LogBody.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mock } from "@plurnk/plurnk-providers";
import { openMigrated, insertWorkspace, insertSession, insertLoop, insertTurn, sendingOperation, holdChild } from "./_db.ts";
import { logEntries, packetSection } from "./_packet.ts";
import { withDaemon, waitForDb } from "./_rpc.ts";
import { makeMockResponse, makeRawMockResponse } from "./_mock.ts";
import { PlurnkParser } from "@plurnk/plurnk-parser";

describe("Engine.addressed-messages", () => {
const frame = PlurnkParser.frame;

test("{§message-source-scheme} restart retains source text and answered state after both observations are curated", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-message-restart-"));
    const path = join(root, "plurnk.db");
    let db = await openMigrated(path);
    try {
        const workspaceId = await insertWorkspace(db, "retained-message");
        const sessionId = await insertSession(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, sessionId, 1, "Keep this original assignment.");
        const [message] = await db.message_source_resources.all<{ path: string }>({ workspace_id: workspaceId, scheme: "message", target: null });
        const address = message.path;
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const provider = new Mock({ contextWindow: 100000, responses: [
            makeRawMockResponse([frame("SEND", "Original answer."), frame("SEND [200]", null)].join("\n\n")),
            makeRawMockResponse([frame("KILL (log:///**/SEND)", null), frame("SEND", "History curated.")].join("\n\n")),
            makeRawMockResponse(frame("SEND [200]", null)),
        ] });
        const answered = await engine.runTurn({ messages: [], provider, workspaceId, sessionId, loopId });
        assert.equal(answered.status, 200);
        const turn = await db.test_get_turn.get<{ sequence: number }>({ id: answered.turnId });
        const original = (await db.test_log_entries_by_turn.all<{ op: string; origin: string; sequence: number }>({ turn_id: answered.turnId }))
            .find(({ op, origin }) => op === "SEND" && origin === "model");
        assert.ok(turn && original);
        const originalLog = `log:///1/${turn.sequence}/${original.sequence}/SEND`;
        const curationLoop = await insertLoop(db, sessionId, 2, "Curate the earlier log.");
        assert.equal((await engine.runTurn({ messages: [], provider, workspaceId, sessionId, loopId: curationLoop })).status, 102);
        assert.equal((await engine.runTurn({ messages: [], provider, workspaceId, sessionId, loopId: curationLoop })).status, 200);
        await db.close();
        db = await openMigrated(path);
        const reopened = new Engine({ db, schemes: new SchemeRegistry() });
        const readingLoop = await insertLoop(db, sessionId, 3, "Inspect the original assignment.");
        const reader = new Mock({ contextWindow: 100000, responses: [makeRawMockResponse([
            frame(`READ (${address}) <1,-1>`, null),
            frame(`READ (${originalLog}) <1,-1>`, null),
        ].join("\n\n"))] });
        const read = await reopened.runTurn({ messages: [], provider: reader, workspaceId, sessionId, loopId: readingLoop });
        assert.deepEqual(read.outcomes.map(({ status }) => status), [200, 404], "the source survives while the curated log remains gone");
        const rows = await db.test_log_entries_by_turn.all<{ op: string; status_rx: number; rx: string; attrs: string }>({ turn_id: read.turnId });
        const retained = rows.find((row) => row.op === "READ" && row.status_rx === 200 && !LogEntryProjection.isEmission(row));
        assert.ok(retained);
        assert.equal(JSON.parse(retained.rx).content, "Keep this original assignment.");
        assert.equal((await db.message_unanswered_count.get({ loop_id: loopId }))?.count, 0, "curation and restart do not revoke the answer");
        const history = await db.message_history.all<{ body: string }>({ workspace_id: workspaceId, session_id: sessionId, loop_id: loopId });
        assert.deepEqual(history.map(({ body }) => body), ["Keep this original assignment.", "Original answer."]);
    } finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("{§message-completion} failed exact delivery does not acknowledge the loop's assignment", async (t) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, "reply-failure");
    const sessionId = await insertSession(db, workspaceId, null, "alice");
    const loopId = await insertLoop(db, sessionId, 1, "An unanswered assignment.");
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    const provider = new Mock({ contextWindow: 100000, responses: [
        makeRawMockResponse(frame("SEND (message://alice/ffffffff)", "Not delivered.")),
        makeRawMockResponse(frame("SEND [200]", "The real answer.")),
    ] });
    const run = () => engine.runTurn({ messages: [], provider, workspaceId, sessionId, loopId });
    const failed = await run();
    assert.equal(failed.status, 102);
    assert.equal(failed.outcomes[0].status, 404);
    const rows = await db.test_log_entries_by_turn.all<{ origin: string; rx: string }>({ turn_id: failed.turnId });
    const row = rows.find(({ origin }) => origin === "model");
    assert.ok(row);
    assert.match(JSON.parse(row.rx).problem.type, /message-not-found$/);
    assert.equal((await db.message_unanswered_count.get({ loop_id: loopId }))?.count, 1);
    assert.equal((await run()).status, 200);
    const history = await db.message_history.all<{ direction: string; body: string }>({ workspace_id: workspaceId, session_id: sessionId, loop_id: loopId });
    assert.deepEqual(history.filter(({ direction }) => direction === "outbound").map(({ body }) => body), ["The real answer."]);
});

for (const delegated of [false, true]) for (const addressed of [false, true]) {
    test(`{§op-methods-op-dispatch} ${delegated ? "child" : "root"} recovers with ${addressed ? "an exact" : "a targetless"} reply`, async (t) => {
        const db = await openMigrated();
        t.after(() => db.close());
        const workspaceId = await insertWorkspace(db, "entry-send-recovery");
        const parentId = delegated ? await insertSession(db, workspaceId, null, "parent") : null;
        const parentLoop = parentId === null ? null : await insertLoop(db, parentId, 1, "Collect the answer.");
        const sessionId = await insertSession(db, workspaceId, parentId, "responder");
        const loopId = await insertLoop(db, sessionId, 1);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        await engine.injectIntoLoop(loopId, "The original request.", [], delegated ? "session://parent" : undefined);
        const requests = await db.message_source_resources.all<{ path: string; body: string }>({ workspace_id: workspaceId, scheme: "message", target: null });
        const request = requests.find(({ body }) => body === "The original request.");
        assert.ok(request);
        const address = request.path;
        const provider = new Mock({ contextWindow: 100000, responses: [
            makeRawMockResponse(frame("SEND (workspace:///_plurnk)", "Answer.")),
            makeRawMockResponse(frame(addressed ? `SEND (${address})` : "SEND", "Recovered answer.")),
            makeRawMockResponse(frame("SEND [200]", null)),
        ] });
        const run = () => engine.runTurn({ messages: [], provider, workspaceId, sessionId, loopId });
        const failed = await run();
        assert.equal(failed.status, 102);
        assert.equal(failed.outcomes[0].status, 501);
        const failedRows = await db.test_log_entries_by_turn.all<{ origin: string; rx: string }>({ turn_id: failed.turnId });
        const problem = JSON.parse(failedRows.find(({ origin }) => origin === "model")!.rx).problem;
        assert.match(problem.type, /message-not-implemented$/);
        assert.equal(problem.detail, "SEND does not deliver messages to workspace entries.");
        assert.equal(problem.recovery, "To reply, SEND to an Open Message address or omit the target. SEND (session://<name>) sends a new message.");
        assert.equal((await db.message_unanswered_count.get({ loop_id: loopId }))?.count, 1);

        assert.equal((await run()).status, 102, "both reply forms are messaging, not completion");
        assert.equal((await run()).status, 200, "the completion reply resolves the answered task");
        assert.equal((await db.message_unanswered_count.get({ loop_id: loopId }))?.count, 0);
        const history = await db.message_history.all<{ direction: string; body: string }>({ workspace_id: workspaceId, session_id: sessionId, loop_id: loopId });
        assert.deepEqual(history.map(({ direction, body }) => ({ direction, body })), [
            { direction: "inbound", body: "The original request." },
            { direction: "outbound", body: "Recovered answer." },
        ]);
        if (parentId !== null && parentLoop !== null) {
            const observed = await engine.runTurn({
                messages: [], workspaceId, sessionId: parentId, loopId: parentLoop,
                provider: new Mock({ contextWindow: 100000, responses: [makeRawMockResponse(frame("NOTE", "Observed."))] }),
            });
            const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: observed.turnId }))!.packet);
            const delivered = logEntries(packet).filter(({ body }) => String(body).includes("Recovered answer."));
            assert.equal(delivered.length, 1, "the reply reaches the parent exactly once");
            assert.equal(delivered[0].path, "ops://responder/1");
            assert.equal(delivered[0].answers, undefined, "the conclusion is not another answer");
        }
    });
}

test("{§message-source-scheme} one source address identifies one immutable message per workspace", async (t) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const address = "acp://operator/threads/shared/messages/m1";
    const workspaces = await Promise.all(["first", "second"].map((name) => insertWorkspace(db, name)));
    for (const workspaceId of workspaces) {
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "Initial assignment.");
        const envelope = { loop_id: loopId, source: address, body: "Accepted.", open_paths: "[]", evidence: "{}", address, opened_turn_id: null, opened_sequence: null };
        await db.drain_enqueue_message.get(envelope);
        await assert.rejects(db.drain_enqueue_message.get({ ...envelope, body: "Replacement." }),
            /message address already accepted in this workspace/);
        const retained = await db.message_source_by_address.get<{ body: string }>({ workspace_id: workspaceId, path: address });
        assert.equal(retained?.body, "Accepted.");
        const all = await db.message_source_resources.all({ workspace_id: workspaceId, scheme: "acp", target: address });
        assert.equal(all.length, 1);
    }
});

test("{§message-source-scheme} native message views reject mutations without cancelling their session", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "immutable-message");
        const sessionId = await insertSession(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, sessionId, 1, "Immutable input.");
        const [message] = await db.message_source_resources.all<{ path: string }>({ workspace_id: workspaceId, scheme: "message", target: null });
        const path = message.path;
        const provider = new Mock({ contextWindow: 100000, responses: [makeRawMockResponse([
            frame(`READ (${path}) <1,-1>`, null),
            frame(`EDIT (${path}) <1,-1>`, "Altered."),
            frame(`MOVE (${path}) (workspace:///moved.md)`, null),
            frame(`COPY (${path}) (${path})`, null),
            frame(`KILL (${path})`, null),
        ].join("\n\n"))] });
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const turn = await engine.runTurn({ messages: [], provider, workspaceId, sessionId, loopId });
        assert.equal(turn.status, 102);
        assert.deepEqual(turn.outcomes.map(({ op, status }) => [op, status]), [
            ["READ", 200], ["EDIT", 405], ["MOVE", 405], ["COPY", 405], ["KILL", 405],
        ]);
        const rows = await db.test_log_entries_by_turn.all<{ op: string; rx: string }>({ turn_id: turn.turnId });
        for (const row of rows.filter(({ op }) => ["EDIT", "MOVE", "COPY", "KILL"].includes(op))) {
            assert.match(JSON.parse(row.rx).problem.type, /message-immutable$/);
        }
        const kill = JSON.parse(rows.find(({ op }) => op === "KILL")!.rx).problem;
        assert.equal(kill.detail, `\`${path}\` is a received message; it cannot be edited, moved or killed.`);
        assert.equal(kill.recovery, undefined);
        const retained = await db.message_source_by_address.get<{ body: string }>({ workspace_id: workspaceId, path });
        assert.equal(retained!.body, "Immutable input.");
        assert.equal((await db.test_get_loop_status.get<{ status: number }>({ id: loopId }))!.status, 102);
    } finally { await db.close(); }
});

for (const scope of ["", " <1,-1>"]) test(`{§message-arrival} curation${scope} preserves the native source; exact replies answer only their addressee`, async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "addressed-sources");
        const sessionId = await insertSession(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, sessionId, 1, "First assignment.");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        await engine.injectIntoLoop(loopId, "Second assignment.");
        const messages = await db.message_source_resources.all<{ path: string; body: string }>({
            workspace_id: workspaceId, scheme: "message", target: null,
        });
        const first = messages.find(({ body }) => body === "First assignment.")!.path;
        const second = messages.find(({ body }) => body === "Second assignment.")!.path;
        assert.match(first, /^message:\/\/alice\/[a-f0-9]{8}$/);
        const provider = new Mock({ contextWindow: 100000, responses: [
            makeRawMockResponse([
                frame(`KILL (log:///**/SEND)${scope}`, null),
                frame(`READ (${first}) <1,-1>`, null),
                frame(`COPY (${first}) (workspace:///copy.md)`, null),
                frame(`SEND (${first}) [200]`, "First answer."),
            ].join("\n\n")),
            makeRawMockResponse(frame("NOTE", "Observed the source and copy.")),
            makeRawMockResponse(frame(`SEND (${second}) [200]`, "Second answer.")),
        ] });
        const run = () => engine.runTurn({ messages: [], provider, workspaceId, sessionId, loopId });
        const one = await run();
        assert.equal(one.status, 102, "resource results require observation despite the reply");
        const initial = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: one.turnId }))!.packet);
        const initialLog = packetSection(initial, "log");
        for (const address of [first, second]) {
            assert.ok(initialLog.includes(`"resource":"${address}"`), "each arrival identifies its immutable Open Message source");
        }
        assert.deepEqual(one.outcomes.map(({ op, status }) => [op, status]), [
            ["KILL", 200], ["READ", 200], ["COPY", 201], ["SEND", 200],
        ]);
        const rows = await db.test_log_entries_by_turn.all<{ op: string; rx: string; attrs: string }>({ turn_id: one.turnId });
        assert.equal(JSON.parse(rows.find((row) => row.op === "READ" && !LogEntryProjection.isEmission(row))!.rx).content, "First assignment.");
        const two = await run();
        assert.equal(two.status, 102, "one addressed answer cannot conclude over the second assignment");
        const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: two.turnId }))!.packet);
        assert.match(packetSection(packet, "messages"), new RegExp(second.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        assert.ok(!packetSection(packet, "messages").includes(first));
        assert.equal((await run()).status, 200, "the last completion reply discharges the remaining obligation");
        assert.equal((await db.message_unanswered_count.get<{ count: number }>({ loop_id: loopId }))!.count, 0);
    } finally { await db.close(); }
});

test("{§message-arrival} a targetless reply cannot acknowledge an arrival during inference", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "message-race");
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "Observed assignment.");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const provider = new Mock({ contextWindow: 100000, responses: [
            makeRawMockResponse(frame("SEND [200]", "Answer to the observed assignment.")),
            makeRawMockResponse(frame("SEND [200]", "Answer to the later arrival.")),
        ] });
        const generate = provider.generate.bind(provider);
        let injected = false;
        provider.generate = async (args) => {
            if (!injected) {
                injected = true;
                await engine.injectIntoLoop(loopId, "Arrived during inference.");
            }
            return generate(args);
        };
        assert.equal((await engine.runTurn({ messages: [], provider, workspaceId, sessionId, loopId })).status, 102);
        assert.equal((await db.message_unanswered_count.get<{ count: number }>({ loop_id: loopId }))!.count, 1);
        assert.equal((await engine.runTurn({ messages: [], provider, workspaceId, sessionId, loopId })).status, 200);
    } finally { await db.close(); }
});

for (const child of [false, true]) test(`{§message-arrival} ${child ? "child" : "peer"} answers are visible once, not new requests`, async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `native-reply-${child}`);
        const sessionId = await insertSession(db, workspaceId, null, "alice");
        const peerId = await insertSession(db, workspaceId, child ? sessionId : null, "bob");
        const loopId = await insertLoop(db, sessionId, 1, "Summarize Bob's answer.");
        const peerLoop = await insertLoop(db, peerId, 1);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        await engine.injectIntoLoop(peerLoop, "What did you find?", [], "session://alice", {}, undefined, await sendingOperation(db, loopId));
        const note = new Mock({ contextWindow: 100000, responses: [makeRawMockResponse(frame("NOTE", "Awaiting Bob."))] });
        assert.equal((await engine.runTurn({ messages: [], provider: note, workspaceId, sessionId, loopId })).status, 102);
        const answer = new Mock({ contextWindow: 100000, responses: [makeRawMockResponse(frame("SEND [200]", "Distinct answer from Bob."))] });
        assert.equal((await engine.runTurn({ messages: [], provider: answer, workspaceId, sessionId: peerId, loopId: peerLoop })).status, 200);
        const observed = new Mock({ contextWindow: 100000, responses: [makeRawMockResponse(frame("SEND [200]", "Bob's result is confirmed."))] });
        const completed = await engine.runTurn({ messages: [], provider: observed, workspaceId, sessionId, loopId });
        assert.equal(completed.status, 200);
        const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: completed.turnId }))!.packet);
        const replies = logEntries(packet).filter(({ body }) => String(body).includes("Distinct answer from Bob."));
        if (child) {
            assert.equal(replies.length, 1, "once, not twice");
            assert.equal(replies[0].path, "ops://bob/1");
            assert.equal(replies[0].answers, undefined, "the conclusion is not another answer");
            return;
        }
        assert.equal(replies.length, 1, "one reply, not repeated as activity and terminal deliverable");
        assert.equal(replies[0].source, "session://bob");
        const answers = replies[0].answers;
        assert.ok(Array.isArray(answers), "the parent packet names answered messages as answers");
        assert.equal(answers.length, 1);
        const answered = await db.message_source_by_address.get<{ body: string; source: string }>({
            workspace_id: workspaceId, path: answers[0],
        });
        assert.equal(answered?.body, "What did you find?", "answers identifies the original request, not its recipient actor");
        assert.equal(answered?.source, "session://alice");
        assert.equal(Object.hasOwn(replies[0], "recipients"), false);
        const inbox = await db.test_messages_by_loop.all({ loop_id: loopId });
        assert.equal(inbox.length, 1, "reply never becomes a request to reply back to Bob");
    } finally { await db.close(); }
});

test("{§message-arrival} another session's addressed answer reaches both the sender and the assigned session", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "third-session-reply");
        const senderId = await insertSession(db, workspaceId, null, "alice");
        const ownerId = await insertSession(db, workspaceId, null, "bob");
        const responderId = await insertSession(db, workspaceId, null, "charlie");
        const senderLoop = await insertLoop(db, senderId, 1, "Collect the answer.");
        const ownerLoop = await insertLoop(db, ownerId, 1);
        const responderLoop = await insertLoop(db, responderId, 1);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        await engine.injectIntoLoop(ownerLoop, "A shared assignment.", [], "session://alice", {}, undefined, await sendingOperation(db, senderLoop));
        const messages = await db.message_source_resources.all<{ path: string; body: string }>({ workspace_id: workspaceId, scheme: "message", target: null });
        const path = messages.find(({ body }) => body === "A shared assignment.")!.path;
        const run = (sessionId: number, loopId: number, program: string) => engine.runTurn({
            messages: [], workspaceId, sessionId, loopId,
            provider: new Mock({ contextWindow: 100000, responses: [makeRawMockResponse(program)] }),
        });
        await run(senderId, senderLoop, frame("NOTE", "Waiting for the answer."));
        await run(ownerId, ownerLoop, frame("NOTE", "Reviewing the assignment."));
        assert.equal((await run(responderId, responderLoop, frame(`SEND (${path}) [200]`, "Charlie's answer."))).status, 200, "the responder has no remaining obligations");
        const history = await db.message_history.all<{ direction: string; body: string }>({ workspace_id: workspaceId, session_id: ownerId, loop_id: ownerLoop });
        assert.deepEqual(history.filter(({ direction }) => direction === "outbound").map(({ body }) => body), ["Charlie's answer."]);
        const completed = await run(ownerId, ownerLoop, "");
        assert.equal(completed.status, 200);
        const result = await db.lifecycle_loop_status.get<{ terminal_result: string }>({ loop_id: ownerLoop });
        assert.equal(JSON.parse(result!.terminal_result).content, undefined, "the answer remains a message, not an execution outcome");
        const observed = await run(senderId, senderLoop, frame("SEND", "Answer collected."));
        for (const turn of [completed, observed]) {
            const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: turn.turnId }))!.packet);
            const replies = logEntries(packet).filter(({ body }) => String(body).includes("Charlie's answer."));
            assert.equal(replies.length, 1);
        }
    } finally { await db.close(); }
});
});

describe("child-completion-observation", () => {
const frame = (op: string, body = "") => `\`\`\`\`${op}\n${body}\n\`\`\`\``;

const fixture = async () => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, "completion-observation");
    const parent = await insertSession(db, workspaceId, null, "parent");
    const parentLoop = await insertLoop(db, parent, 1, "Collect the child's answer.");
    const child = await insertSession(db, workspaceId, parent, "child");
    const childLoop = await insertLoop(db, child, 1);
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    const lifecycle = new LoopLifecycle(db);
    const run = async (sessionId: number, loopId: number, content = frame("NOTE", "Observed.")) => {
        const result = await engine.runTurn({
            messages: [], workspaceId, sessionId, loopId,
            provider: new Mock({ contextWindow: 100_000, responses: [{ assistant: { content, reasoning: null } }] }),
        });
        const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: result.turnId }))!.packet);
        return { result, packet, entries: logEntries(packet) };
    };
    return { db, workspaceId, parent, parentLoop, child, childLoop, engine, lifecycle, run };
};

for (const outcome of ["success", "failure", "cancel"] as const) {
    test(`{§message-completion}: the parent receives ${outcome} once, as the child's own loop answer`, async (t) => {
        const f = await fixture();
        t.after(() => f.db.close());
        await f.engine.injectIntoLoop(f.childLoop, "What did you find?", [], "session://parent", {}, undefined, await sendingOperation(f.db, f.parentLoop));
        await f.run(f.child, f.childLoop, frame("SEND", "The answer is 42.") + "\n\n" + frame("FIND (*)"));
        const before = await f.run(f.parent, f.parentLoop);
        assert.deepEqual(before.entries.filter(({ answers }) => Array.isArray(answers)), [],
            "the answer to the parent's own task is not delivered twice: it arrives with the conclusion");
        assert.equal(before.entries.filter(({ path: target }) => target === "ops://child/1").length, 0, "an answer before the conclusion implies no completion");

        const result = outcome === "success"
            ? { status: 200 }
            : Results.failure("test:child", outcome, outcome === "cancel" ? 499 : 502, "The child could not finish.");
        const exact = await f.lifecycle.finish(f.childLoop, result, { terminatedBy: outcome === "cancel" ? "cancel" : null });
        assert.ok(exact);
        const after = await f.run(f.parent, f.parentLoop);
        const observations = after.entries.filter(({ source }) => source === "session://child");
        assert.deepEqual(observations.map(({ logPath: path }) => path.split("/").at(-1)), ["READ"]);
        const completion = observations[0];
        assert.equal(completion.path, "ops://child/1");
        assert.equal(completion.origin, "_plurnk");
        assert.equal(completion.answers, undefined, "observation is not another answer");
        if (outcome === "success") {
            assert.match(String(completion.body), /The answer is 42\./, "the conclusion carries what the child said");
        } else {
            assert.equal(completion.status, exact.status);
            assert.match(JSON.stringify(completion), /The child could not finish\./);
            assert.ok(String(completion.body).length > 0, "a failure stays visible even after an answer was written");
            if (outcome === "cancel") assert.match(String(completion.body), /session cancelled/);
        }
        const history = await f.db.message_history.all<{ direction: string; body: string }>({ workspace_id: f.workspaceId, session_id: f.child, loop_id: f.childLoop });
        assert.deepEqual(history.filter(({ direction }) => direction === "outbound").map(({ body }) => body), ["The answer is 42."], "the reply is still the child's own outbound message");
    });
}

test("{§env-delta}: delayed observation preserves each completed loop after newer work starts", async (t) => {
    const f = await fixture();
    t.after(() => f.db.close());
    const first = Array.from({ length: 24 }, (_, i) => `First result line ${i + 1}`).join("\n");
    await insertTurn(f.db, f.childLoop, 1);
    assert.ok(await f.lifecycle.finish(f.childLoop, { status: 200, content: first, mimetype: "text/plain" }));
    const secondLoop = await insertLoop(f.db, f.child, 2);
    await insertTurn(f.db, secondLoop, 1);
    const failure = await f.lifecycle.finish(secondLoop, Results.failure("test:child", "second-loop-failed", 502, "Second loop failed."));
    assert.ok(failure);
    const thirdLoop = await insertLoop(f.db, f.child, 3, "Still running.");
    assert.equal(await f.lifecycle.status(thirdLoop), 102);

    const observed = await f.run(f.parent, f.parentLoop);
    const completions = observed.entries.filter(({ path: target }) => String(target).startsWith("ops://child/"));
    assert.equal(completions.length, 2);
    assert.ok(completions.every(({ logPath: path }) => path.endsWith("/READ")));
    assert.deepEqual(completions.map(({ path: target }) => target), ["ops://child/1", "ops://child/2"]);
    assert.match(String(completions[0].body), /First result line 1\n/);
    assert.match(String(completions[0].body), /First result line 24/, "automatic observation is a markerless READ: whole when it fits ({§tokenomics})");
    assert.equal(completions[0].preview, undefined, "nothing is previewed on the model's behalf");
    assert.match(String(completions[1].body), /Second loop failed\./);
    assert.equal(completions[1].status, 502);
    assert.equal((await f.db.engine_session_has_undelivered_child_term.get({ session_id: f.parent })), undefined);

    const curated = await f.run(f.parent, f.parentLoop,
        frame(`READ (${String(completions[0].path)}) <1,-1>`) + "\n\n"
        + frame(`KILL (${completions[0].logPath}) <2,-1>`));
    const rows = await f.db.test_log_entries_by_loop.all<{ turn_id: number; op: string; status_rx: number; rx: string; attrs: string }>({ loop_id: f.parentLoop });
    const actions = rows.filter((row) => row.turn_id === curated.result.turnId && !LogEntryProjection.isEmission(row));
    assert.deepEqual(actions.map(({ op, status_rx }) => [op, status_rx]), [["READ", 200], ["KILL", 200]]);
    assert.equal(JSON.parse(actions[0].rx).content, first, "source READ recovers the exact original result, never the current session loop");
    assert.equal((await f.lifecycle.result(f.childLoop))?.content, first, "curation never changes the producer's result");
    assert.deepEqual((await f.lifecycle.result(secondLoop))?.problem, failure.problem);
    const again = await f.run(f.parent, f.parentLoop);
    assert.equal(again.entries.filter(({ source, path }) => source === "session://child" && String(path).startsWith("ops://child/")).length, 2, "observing again creates no duplicate occurrences");
});
});

describe("session-send-scope", () => {
test("{§op-shapes}: a scoped session SEND is refused and admits no task", async () => {
    const provider = new Mock({ contextWindow: 100000, responses: [
        makeMockResponse("````SEND (session://scheduler) <0,60>\nUnadmitted scheduled instruction.\n````\n````NOTE\nInspect the refusal.\n````"),
        makeMockResponse("````SEND [200]\nThe scope was refused.\n````"),
    ] });
    await withDaemon(provider, async (db, daemon) => {
        const { workspaceId } = await daemon.createWorkspace({ name: "send-scope" });
        const sessionId = (await daemon.createSession({ workspaceId, name: "scheduler" })).sessionId;
        try {
            const initial = await daemon.runLoop({ workspaceId, sessionId, prompt: "Send yourself a scoped message." });
            await waitForDb(() => db.test_get_loop_status.get({ id: initial.loopId }), (row) => row?.status === 200);
            const receipts = await db.test_log_entries_by_loop.all<{ op: string; rx: string }>({ loop_id: initial.loopId });
            const refusal = receipts.map(({ rx }) => JSON.parse(rx)).find((rx) => rx.problem?.type.endsWith("/scope-unsupported"));
            assert.equal(refusal?.status, 400);
            assert.equal(refusal.problem.detail, "A session SEND takes no scope.");
            assert.deepEqual((await daemon.listSessionLoops({ workspaceId, sessionId }))
                .filter(({ prompt }) => prompt !== "").map(({ id }) => id), [initial.loopId], "the scoped SEND admitted no task");
            assert.equal(provider.received.length, 2);
        } finally { await daemon.cancelSession({ workspaceId, sessionId }); }
    });
});
});

describe("wait-projection", () => {
for (const [header, warning] of [
    ["WAIT 15", "`WAIT` body text was on the OP line and was taken as the body"],
    ["WAIT <10s>", "Ignored WAIT duration <10s>."],
] as const) {
    test(`{§operation-results} ${header} feedback survives parking, reaches only its loop, and drains once`, async (t) => {
        const db = await openMigrated();
        t.after(() => db.close());
        const workspaceId = await insertWorkspace(db, "wait-feedback");
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "Observe the child result.");
        const childLoopId = await holdChild(db, workspaceId, sessionId);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const lifecycle = new LoopLifecycle(db);
        const provider = new Mock({ contextWindow: 100_000, responses: [header, "WAIT [0.25]", "WAIT", "SEND [200]"].map((line) => ({
            assistant: { content: PlurnkParser.frame(line, null), reasoning: null },
        })) });
        const run = () => engine.runLoop({ provider, workspaceId, sessionId, loopId, messages: [] });
        const packet = async (turnId: number) => JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: turnId }))!.packet);
        const resume = async () => {
            assert.equal(await lifecycle.wake(loopId), true);
            assert.equal((await db.drain_claim_next_loop.get({ session_id: sessionId }))?.id, loopId);
            return run();
        };

        assert.equal((await run()).result.status, 202);
        const siblingId = await insertSession(db, workspaceId);
        const siblingLoop = await insertLoop(db, siblingId, 1, "Finish this independent task.");
        const sibling = await engine.runLoop({
            provider: new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: PlurnkParser.frame("SEND [200]", null), reasoning: null } }] }),
            workspaceId, sessionId: siblingId, loopId: siblingLoop, messages: [],
        });
        assert.equal(sibling.result.status, 200);
        assert.equal(packetSection(await packet(sibling.turnIds.at(-1)!), "notices"), "", "another loop neither consumes nor receives the warning");

        const resumed = await resume();
        assert.equal(resumed.result.status, 202);
        const resumedPacket = await packet(resumed.turnIds.at(-1)!);
        const notices = packetSection(resumedPacket, "notices");
        assert.ok(notices.includes(`> YOU SHOULD write the canonical form. ${warning}`), notices);
        assert.equal(notices.match(/\[parse_advisory\]/gu)?.length, 1);
        const wait = logEntries(resumedPacket).find(({ logPath }) => logPath.endsWith("/WAIT"));
        assert.equal(wait?.waitSeconds, 300, "a duration was not supplied; the configured bound applies");
        if (header === "WAIT 15") assert.ok(packetSection(resumedPacket, "emission-history").includes(PlurnkParser.frame("WAIT", "15")), "the authored prose is retained in its operation");

        const next = await resume();
        assert.equal(next.result.status, 202);
        assert.doesNotMatch(packetSection(await packet(next.turnIds.at(-1)!), "notices"), /\[parse_advisory\]/u,
            "the warning drains on the first resumed packet only");
        await lifecycle.finish(childLoopId, { status: 200 });
        assert.equal((await resume()).result.status, 200);
    });
}

for (const headers of [["WAIT [0]"], ["WAIT [600]", "WAIT [0]"], ["WAIT [0]", "WAIT"]]) {
    test(`{§session-wait-timing} ${headers.join(" + ")} continues silently without parking or cancelling live work`, async (t) => {
        const db = await openMigrated();
        t.after(() => db.close());
        const workspaceId = await insertWorkspace(db, "zero-wait");
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1);
        const childLoopId = await holdChild(db, workspaceId, sessionId);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const lifecycle = new LoopLifecycle(db);
        const run = (source: string) => engine.runTurn({
            provider: new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: source, reasoning: null } }] }),
            workspaceId, sessionId, loopId, messages: [],
        });
        const result = await run([...headers.map((header) => PlurnkParser.frame(header, null)), PlurnkParser.frame("NOTE", "The child is still running.")].join("\n\n"));
        assert.equal(result.status, 102);
        assert.equal(await lifecycle.status(loopId), 102);
        assert.deepEqual(await lifecycle.parked(sessionId), [], "zero creates no parked wait or timer");
        assert.equal(await lifecycle.status(childLoopId), 102, "the child keeps running");
        assert.ok(result.outcomes.some(({ op, status }) => op === "NOTE" && status === 200), "the sibling operation executed");
        const next = await run(PlurnkParser.frame("WAIT", null));
        assert.equal(next.status, 202, "the zero bound does not leak into a later WAIT");
        const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: next.turnId }))!.packet);
        assert.equal(packetSection(packet, "notices"), "", "zero earns no correction");
        const zero = logEntries(packet).find((entry) => entry.logPath.endsWith("/WAIT") && entry.waitSeconds === 0);
        assert.ok(zero, "the no-wait receipt records the accepted zero");
        assert.equal(zero.status, 102);
    });
}

for (const [headers, seconds] of [
    [["WAIT"], 300],
    [["WAIT [600]"], 600],
    [["WAIT (session://missing) [0.25]"], 0.25],
    [["WAIT [0.0001]"], 0.0001],
    [["WAIT [600]", "WAIT [120]"], 120],
    [["WAIT [600]", "WAIT"], 300],
    [["SEND [200]"], 300],
] as const) {
    test(`{§session-wait-timing} ${headers.join(" + ")} bounds the child-only park to ${seconds} seconds`, async (t) => {
        t.mock.method(Date, "now", () => 10_000);
        const db = await openMigrated();
        t.after(() => db.close());
        const workspaceId = await insertWorkspace(db, "bounded-child-wait");
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "Observe the child result.");
        const childLoopId = await holdChild(db, workspaceId, sessionId);
        const result = await new Engine({ db, schemes: new SchemeRegistry() }).runTurn({
            provider: new Mock({ contextWindow: 100_000, responses: [{ assistant: {
                content: headers.map((header) => PlurnkParser.frame(header, null)).join("\n\n"), reasoning: null,
            } }] }),
            workspaceId, sessionId, loopId, messages: [],
        });
        assert.equal(result.status, 202);
        const lifecycle = new LoopLifecycle(db);
        const [parked] = await lifecycle.parked(sessionId);
        assert.equal(parked?.wait_poll_at, Math.ceil(10_000 + seconds * 1000));
        assert.equal(await lifecycle.wake(loopId, { revision: parked.wait_revision, dueAt: parked.wait_poll_at }), true);
        assert.equal(await lifecycle.status(loopId), 100, "expiry queues the same loop");
        assert.equal(await lifecycle.status(childLoopId), 102, "expiry does not cancel or conclude the child");
        assert.equal(await lifecycle.result(loopId), null);
        assert.equal(await lifecycle.result(childLoopId), null);
    });
}

test("{§session-wait-timing} an early wake retires the override; a later bare WAIT uses the configured default", async (t) => {
    let now = 10_000;
    t.mock.method(Date, "now", () => now);
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, "one-park-override");
    const sessionId = await insertSession(db, workspaceId);
    const loopId = await insertLoop(db, sessionId, 1);
    await holdChild(db, workspaceId, sessionId);
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    const lifecycle = new LoopLifecycle(db);
    const run = (header: string) => engine.runTurn({
        provider: new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: PlurnkParser.frame(header, null), reasoning: null } }] }),
        workspaceId, sessionId, loopId, messages: [],
    });
    assert.equal((await run("WAIT [600]")).status, 202);
    const [first] = await lifecycle.parked(sessionId);
    assert.equal(first?.wait_poll_at, 610_000);
    now += 1000;
    assert.equal(await lifecycle.wake(loopId), true);
    assert.deepEqual(await lifecycle.parked(sessionId), []);
    assert.equal((await db.drain_claim_next_loop.get({ session_id: sessionId }))?.id, loopId);
    assert.equal((await run("WAIT")).status, 202);
    const [second] = await lifecycle.parked(sessionId);
    assert.equal(second?.wait_poll_at, 311_000);
    assert.equal(second?.wait_revision, first.wait_revision + 1);
    assert.equal(await lifecycle.wake(loopId, { revision: first.wait_revision, dueAt: 610_000 }), false,
        "the previous timer cannot end the new park");
});

for (const header of ["WAIT", "WAIT (sh:///missing) <60,60> [{\"timeout\":42}]"]) {
    test(`{§op-shapes} {§loop-completion} ${header} parks on the actual live child, not the decoration`, async (t) => {
        const db = await openMigrated();
        t.after(() => db.close());
        const workspaceId = await insertWorkspace(db, "wait-obligations");
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "Await the child.");
        await holdChild(db, workspaceId, sessionId);
        const source = [PlurnkParser.frame(header, "Await results."), PlurnkParser.frame("NOTE", "The child is checking.")].join("\n\n");
        const result = await new Engine({ db, schemes: new SchemeRegistry() }).runTurn({
            provider: new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: source, reasoning: null } }] }),
            workspaceId, sessionId, loopId, messages: [],
        });
        assert.equal(result.status, 202);
        assert.equal(await new LoopLifecycle(db).status(loopId), 202);
        assert.deepEqual(result.outcomes.map(({ op, status }) => [op, status]), [["NOTE", 200], ["WAIT", 202]], "WAIT still settles after its sibling");
        const rows = await db.test_log_entries_by_turn.all<{ op: string; tx: string; rx: string }>({ turn_id: result.turnId });
        const wait = rows.find(({ op }) => op === "WAIT");
        assert.ok(wait);
        const tx = JSON.parse(wait.tx);
        assert.equal(tx.target?.raw ?? null, header === "WAIT" ? null : "sh:///missing");
        assert.equal(tx.lineMarker, null);
        assert.equal(tx.metadata, null);
        assert.equal(tx.body, "Await results.");
        assert.equal(JSON.parse(wait.rx).problem, undefined);
        const attempts = await db.test_turn_attempts.all<{ accepted: number; parse_errors: string }>({ turn_id: result.turnId });
        assert.deepEqual(attempts.map(({ accepted, parse_errors }) => [accepted, JSON.parse(parse_errors)]), [[1, []]]);
    });
}

test("{§op-shapes} {§loop-completion} WAIT retains literal prose without inventing a response", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "continuation-inventory");
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "Report the outcome.");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const body = "Report the findings.";
        const source = PlurnkParser.frame("WAIT", body);
        const result = await engine.runTurn({
            provider: new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: source, reasoning: null } }] }),
            workspaceId, sessionId, loopId, messages: [],
        });
        assert.equal(result.status, 102, "absence of live work does not complete a waiting task");
        const terminal = await new LoopLifecycle(db).result(loopId);
        assert.equal(terminal, null, "no deliverable is manufactured from a wait");
        const rows = await db.test_log_entries_by_turn.all<{ op: string | null; origin: string; attrs: string; tx: string; rx: string; status_rx: number }>({ turn_id: result.turnId });
        assert.deepEqual(rows.filter((row) => row.origin === "model" && !LogEntryProjection.isEmission(row)).map(({ op }) => op), ["WAIT"]);
        const wait = rows.find(({ op }) => op === "WAIT")!;
        assert.equal(wait.status_rx, 102);
        assert.equal(JSON.parse(wait.rx).detail, "Nothing is in flight. Continuing.");
        assert.equal(JSON.parse(wait.tx).body, body);
        const projection = LogBody.resolve({ op: "WAIT", tx: JSON.parse(wait.tx), rx: JSON.parse(wait.rx) });
        assert.equal(projection.mimetype, "text/plain");
        assert.equal(projection.content, body);
    } finally { await db.close(); }
});

test("{§loop-completion} every idle WAIT receives the same plain receipt, however often it repeats", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `idle-wait-${crypto.randomUUID()}`);
        const sessionId = await insertSession(db, workspaceId);
        const loopId = await insertLoop(db, sessionId, 1, "Report the outcome.");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const source = PlurnkParser.frame("WAIT", "Awaiting the answer.");
        const detailOf = async () => {
            const result = await engine.runTurn({
                provider: new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: source, reasoning: null } }] }),
                workspaceId, sessionId, loopId, messages: [],
            });
            assert.equal(result.status, 102, "an idle WAIT neither parks nor resolves the open message");
            const rows = await db.test_log_entries_by_turn.all<{ op: string | null; rx: string }>({ turn_id: result.turnId });
            return JSON.parse(rows.find(({ op }) => op === "WAIT")!.rx).detail as string;
        };

        const details = [await detailOf(), await detailOf(), await detailOf()];
        assert.deepEqual(details, Array(3).fill("Nothing is in flight. Continuing."), "a repeated idle WAIT is never corrected");
    } finally { await db.close(); }
});
});
