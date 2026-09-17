import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mock } from "@plurnk/plurnk-providers";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { insertLoop, insertWorker, insertWorkspace, logEntries, openMigrated, packetSection } from "./_helpers.ts";
import { makeRawMockResponse } from "./_rpc.ts";

const frame = PlurnkParser.frame;

test("{§message-source-scheme} restart retains source text and answered state after both observations are curated", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-message-restart-"));
    const path = join(root, "plurnk.db");
    let db = await openMigrated(path);
    try {
        const workspaceId = await insertWorkspace(db, "retained-message");
        const workerId = await insertWorker(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, workerId, 1, "Keep this original assignment.");
        const [message] = await db.message_source_resources.all<{ path: string }>({ workspace_id: workspaceId, scheme: "worker", target: null });
        const address = message!.path;
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const provider = new Mock({ contextWindow: 100000, responses: [
            makeRawMockResponse(frame("SEND", "Original answer.")),
            makeRawMockResponse([frame("KILL (log:///**/SEND)", null), frame("SEND", "History curated.")].join("\n\n")),
        ] });
        const answered = await engine.runTurn({ messages: [], provider, workspaceId, workerId, loopId });
        assert.equal(answered.status, 200);
        const turn = await db.test_get_turn.get<{ sequence: number }>({ id: answered.turnId });
        const original = (await db.test_log_entries_by_turn.all<{ op: string; origin: string; sequence: number }>({ turn_id: answered.turnId }))
            .find(({ op, origin }) => op === "SEND" && origin === "model");
        assert.ok(turn && original);
        const originalLog = `log:///1/${turn.sequence}/${original.sequence}/SEND`;
        const curationLoop = await insertLoop(db, workerId, 2, "Curate the prior conversation.");
        assert.equal((await engine.runTurn({ messages: [], provider, workspaceId, workerId, loopId: curationLoop })).status, 200);
        await db.close();
        db = await openMigrated(path);
        const reopened = new Engine({ db, schemes: new SchemeRegistry() });
        const readingLoop = await insertLoop(db, workerId, 3, "Inspect the original assignment.");
        const reader = new Mock({ contextWindow: 100000, responses: [makeRawMockResponse([
            frame(`READ (${address}) <1,-1>`, null),
            frame(`READ (${originalLog}) <1,-1>`, null),
        ].join("\n\n"))] });
        const read = await reopened.runTurn({ messages: [], provider: reader, workspaceId, workerId, loopId: readingLoop });
        assert.deepEqual(read.outcomes.map(({ status }) => status), [200, 404], "the source survives while the curated log remains gone");
        const rows = await db.test_log_entries_by_turn.all<{ op: string; status_rx: number; rx: string }>({ turn_id: read.turnId });
        const retained = rows.find(({ op, status_rx }) => op === "READ" && status_rx === 200);
        assert.ok(retained);
        assert.equal(JSON.parse(retained.rx).content, "Keep this original assignment.");
        assert.equal((await db.message_unanswered_count.get({ loop_id: loopId }))?.count, 0, "curation and restart do not revoke the answer");
        const history = await db.message_history.all<{ body: string }>({ workspace_id: workspaceId, worker_id: workerId, loop_id: loopId });
        assert.deepEqual(history.map(({ body }) => body), ["Keep this original assignment.", "Original answer."]);
    } finally {
        await db.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("{§send-response-receipt} failed exact delivery does not acknowledge the loop's assignment", async (t) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, "reply-failure");
    const workerId = await insertWorker(db, workspaceId, null, "alice");
    const loopId = await insertLoop(db, workerId, 1, "An unanswered assignment.");
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    const provider = new Mock({ contextWindow: 100000, responses: [
        makeRawMockResponse(frame("SEND (worker://alice/?message=ffffffff)", "Not delivered.")),
        makeRawMockResponse(frame("SEND", "The real answer.")),
    ] });
    const run = () => engine.runTurn({ messages: [], provider, workspaceId, workerId, loopId });
    const failed = await run();
    assert.equal(failed.status, 102);
    assert.equal(failed.outcomes[0]!.status, 404);
    const rows = await db.test_log_entries_by_turn.all<{ origin: string; rx: string }>({ turn_id: failed.turnId });
    const row = rows.find(({ origin }) => origin === "model");
    assert.ok(row);
    assert.match(JSON.parse(row.rx).problem.type, /message-not-found$/);
    assert.equal((await db.message_unanswered_count.get({ loop_id: loopId }))?.count, 1);
    assert.equal((await run()).status, 200);
    const history = await db.message_history.all<{ direction: string; body: string }>({ workspace_id: workspaceId, worker_id: workerId, loop_id: loopId });
    assert.deepEqual(history.filter(({ direction }) => direction === "outbound").map(({ body }) => body), ["The real answer."]);
});

for (const delegated of [false, true]) for (const addressed of [false, true]) {
    test(`{§send-dispatch-entry-schemes-501} ${delegated ? "child" : "root"} recovers with ${addressed ? "an exact" : "a targetless"} reply`, async (t) => {
        const db = await openMigrated();
        t.after(() => db.close());
        const workspaceId = await insertWorkspace(db, "entry-send-recovery");
        const parentId = delegated ? await insertWorker(db, workspaceId, null, "parent") : null;
        const parentLoop = parentId === null ? null : await insertLoop(db, parentId, 1, "Collect the answer.");
        const workerId = await insertWorker(db, workspaceId, parentId, "responder");
        const loopId = await insertLoop(db, workerId, 1);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        await engine.injectIntoLoop(loopId, "The original request.", [], delegated ? "worker://parent" : undefined);
        const requests = await db.message_source_resources.all<{ path: string; body: string }>({ workspace_id: workspaceId, scheme: "worker", target: null });
        const request = requests.find(({ body }) => body === "The original request.");
        assert.ok(request);
        const address = request.path;
        const provider = new Mock({ contextWindow: 100000, responses: [
            makeRawMockResponse(frame("SEND (worker:///_plurnk)", "Answer.")),
            makeRawMockResponse(frame(addressed ? `SEND (${address})` : "SEND", "Recovered answer.")),
        ] });
        const run = () => engine.runTurn({ messages: [], provider, workspaceId, workerId, loopId });
        const failed = await run();
        assert.equal(failed.status, 102);
        assert.equal(failed.outcomes[0]!.status, 501);
        const failedRows = await db.test_log_entries_by_turn.all<{ origin: string; rx: string }>({ turn_id: failed.turnId });
        const problem = JSON.parse(failedRows.find(({ origin }) => origin === "model")!.rx).problem;
        assert.match(problem.type, /message-not-implemented$/);
        assert.equal(problem.detail, "SEND does not deliver messages to worker entries.");
        assert.equal(problem.recovery, "To reply, SEND to an Open Message address or omit the target. SEND (worker://<name>) sends a new message.");
        assert.equal((await db.message_unanswered_count.get({ loop_id: loopId }))?.count, 1);

        assert.equal((await run()).status, 200);
        assert.equal((await db.message_unanswered_count.get({ loop_id: loopId }))?.count, 0);
        const history = await db.message_history.all<{ direction: string; body: string }>({ workspace_id: workspaceId, worker_id: workerId, loop_id: loopId });
        assert.deepEqual(history.map(({ direction, body }) => ({ direction, body })), [
            { direction: "inbound", body: "The original request." },
            { direction: "outbound", body: "Recovered answer." },
        ]);
        if (parentId !== null && parentLoop !== null) {
            const observed = await engine.runTurn({
                messages: [], workspaceId, workerId: parentId, loopId: parentLoop,
                provider: new Mock({ contextWindow: 100000, responses: [makeRawMockResponse(frame("NOTE", "Observed."))] }),
            });
            const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: observed.turnId }))!.packet);
            const replies = logEntries(packet).filter(({ body }) => String(body).includes("Recovered answer."));
            assert.equal(replies.length, 1, "the reply reaches the parent exactly once");
            assert.deepEqual(replies[0]!.answers, [address]);
        }
    });
}

test("{§message-source-scheme} one source address identifies one immutable message per workspace", async (t) => {
    const db = await openMigrated();
    t.after(() => db.close());
    const address = "agui://anonymous/threads/shared/messages/m1";
    const workspaces = await Promise.all(["first", "second"].map((name) => insertWorkspace(db, name)));
    for (const workspaceId of workspaces) {
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "Initial assignment.");
        const envelope = { loop_id: loopId, source: address, body: "Accepted.", open_paths: "[]", evidence: "{}", address };
        await db.drain_enqueue_message.get(envelope);
        await assert.rejects(db.drain_enqueue_message.get({ ...envelope, body: "Replacement." }),
            /message address already accepted in this workspace/);
        const retained = await db.message_source_by_address.get<{ body: string }>({ workspace_id: workspaceId, path: address });
        assert.equal(retained?.body, "Accepted.");
        const all = await db.message_source_resources.all({ workspace_id: workspaceId, scheme: "agui", target: address });
        assert.equal(all.length, 1);
    }
});

test("{§message-source-scheme} native message views reject mutations without cancelling their worker", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "immutable-message");
        const workerId = await insertWorker(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, workerId, 1, "Immutable input.");
        const [message] = await db.message_source_resources.all<{ path: string }>({ workspace_id: workspaceId, scheme: "worker", target: null });
        const path = message!.path;
        const provider = new Mock({ contextWindow: 100000, responses: [makeRawMockResponse([
            frame(`READ (${path}) <1,-1>`, null),
            frame(`EDIT (${path}) <1,-1>`, "Altered."),
            frame(`MOVE (${path}) (worker:///moved.md)`, null),
            frame(`COPY (${path}) (${path})`, null),
            frame(`KILL (${path})`, null),
        ].join("\n\n"))] });
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const turn = await engine.runTurn({ messages: [], provider, workspaceId, workerId, loopId });
        assert.equal(turn.status, 102);
        assert.deepEqual(turn.outcomes.map(({ op, status }) => [op, status]), [
            ["READ", 200], ["EDIT", 405], ["MOVE", 405], ["COPY", 405], ["KILL", 405],
        ]);
        const rows = await db.test_log_entries_by_turn.all<{ op: string; rx: string }>({ turn_id: turn.turnId });
        for (const row of rows.filter(({ op }) => ["EDIT", "MOVE", "COPY", "KILL"].includes(op))) {
            assert.match(JSON.parse(row.rx).problem.type, /message-immutable$/);
        }
        const retained = await db.message_source_by_address.get<{ body: string }>({ workspace_id: workspaceId, path });
        assert.equal(retained!.body, "Immutable input.");
        assert.equal((await db.test_get_loop_status.get<{ status: number }>({ id: loopId }))!.status, 102);
    } finally { await db.close(); }
});

for (const scope of ["", " <1,-1>"]) test(`{§message-arrival} curation${scope} preserves the native source; exact replies answer only their addressee`, async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "addressed-sources");
        const workerId = await insertWorker(db, workspaceId, null, "alice");
        const loopId = await insertLoop(db, workerId, 1, "First assignment.");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        await engine.injectIntoLoop(loopId, "Second assignment.");
        const messages = await db.message_source_resources.all<{ path: string; body: string }>({
            workspace_id: workspaceId, scheme: "worker", target: null,
        });
        const first = messages.find(({ body }) => body === "First assignment.")!.path;
        const second = messages.find(({ body }) => body === "Second assignment.")!.path;
        assert.match(first, /^worker:\/\/alice\/\?message=[a-f0-9]{8}$/);
        const provider = new Mock({ contextWindow: 100000, responses: [
            makeRawMockResponse([
                frame(`KILL (log:///**/SEND)${scope}`, null),
                frame(`READ (${first}) <1,-1>`, null),
                frame(`COPY (${first}) (worker:///copy.md)`, null),
                frame(`SEND (${first})`, "First answer."),
            ].join("\n\n")),
            makeRawMockResponse(frame("NOTE", "Observed the source and copy.")),
            makeRawMockResponse(frame(`SEND (${second})`, "Second answer.")),
        ] });
        const run = () => engine.runTurn({ messages: [], provider, workspaceId, workerId, loopId });
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
        const rows = await db.test_log_entries_by_turn.all<{ op: string; rx: string }>({ turn_id: one.turnId });
        assert.equal(JSON.parse(rows.find(({ op }) => op === "READ")!.rx).content, "First assignment.");
        const two = await run();
        assert.equal(two.status, 102, "one addressed answer cannot conclude over the second assignment");
        const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: two.turnId }))!.packet);
        assert.match(packetSection(packet, "messages"), new RegExp(second.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        assert.ok(!packetSection(packet, "messages").includes(first));
        assert.equal((await run()).status, 200, "all messages answered and results observed, without a terminal verb");
        assert.equal((await db.message_unanswered_count.get<{ count: number }>({ loop_id: loopId }))!.count, 0);
    } finally { await db.close(); }
});

test("{§completion-defers-to-messages} a targetless reply cannot acknowledge an arrival during inference", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "message-race");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "Observed assignment.");
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const provider = new Mock({ contextWindow: 100000, responses: [
            makeRawMockResponse(frame("SEND", "Answer to the observed assignment.")),
            makeRawMockResponse(frame("SEND", "Answer to the later arrival.")),
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
        assert.equal((await engine.runTurn({ messages: [], provider, workspaceId, workerId, loopId })).status, 102);
        assert.equal((await db.message_unanswered_count.get<{ count: number }>({ loop_id: loopId }))!.count, 1);
        assert.equal((await engine.runTurn({ messages: [], provider, workspaceId, workerId, loopId })).status, 200);
    } finally { await db.close(); }
});

for (const child of [false, true]) test(`{§message-reply-delivery} ${child ? "child" : "peer"} answers are visible once, not new requests`, async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `native-reply-${child}`);
        const workerId = await insertWorker(db, workspaceId, null, "alice");
        const peerId = await insertWorker(db, workspaceId, child ? workerId : null, "bob");
        const loopId = await insertLoop(db, workerId, 1, "Summarize Bob's answer.");
        const peerLoop = await insertLoop(db, peerId, 1);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        await engine.injectIntoLoop(peerLoop, "What did you find?", [], "worker://alice");
        const note = new Mock({ contextWindow: 100000, responses: [makeRawMockResponse(frame("NOTE", "Awaiting Bob."))] });
        assert.equal((await engine.runTurn({ messages: [], provider: note, workspaceId, workerId, loopId })).status, 102);
        const answer = new Mock({ contextWindow: 100000, responses: [makeRawMockResponse(frame("SEND", "Distinct answer from Bob."))] });
        assert.equal((await engine.runTurn({ messages: [], provider: answer, workspaceId, workerId: peerId, loopId: peerLoop })).status, 200);
        const observed = new Mock({ contextWindow: 100000, responses: [makeRawMockResponse(frame("SEND", "Bob's result is confirmed."))] });
        const completed = await engine.runTurn({ messages: [], provider: observed, workspaceId, workerId, loopId });
        assert.equal(completed.status, 200);
        const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: completed.turnId }))!.packet);
        const replies = logEntries(packet).filter(({ body }) => String(body).includes("Distinct answer from Bob."));
        assert.equal(replies.length, 1, "one reply, not repeated as activity and terminal deliverable");
        assert.equal(replies[0]!.source, "worker://bob");
        const answers = replies[0]!.answers;
        assert.ok(Array.isArray(answers), "the parent packet names answered messages as answers");
        assert.equal(answers.length, 1);
        const answered = await db.message_source_by_address.get<{ body: string; source: string }>({
            workspace_id: workspaceId, path: answers[0],
        });
        assert.equal(answered?.body, "What did you find?", "answers identifies the original request, not its recipient actor");
        assert.equal(answered?.source, "worker://alice");
        assert.equal(Object.hasOwn(replies[0]!, "recipients"), false);
        const inbox = await db.test_messages_by_loop.all({ loop_id: loopId });
        assert.equal(inbox.length, 1, "reply never becomes a request to reply back to Bob");
    } finally { await db.close(); }
});

test("{§message-reply-delivery} another worker's addressed answer reaches both the sender and assigned conversation", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "third-worker-reply");
        const senderId = await insertWorker(db, workspaceId, null, "alice");
        const ownerId = await insertWorker(db, workspaceId, null, "bob");
        const responderId = await insertWorker(db, workspaceId, null, "charlie");
        const senderLoop = await insertLoop(db, senderId, 1, "Collect the answer.");
        const ownerLoop = await insertLoop(db, ownerId, 1);
        const responderLoop = await insertLoop(db, responderId, 1);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        await engine.injectIntoLoop(ownerLoop, "A shared assignment.", [], "worker://alice");
        const messages = await db.message_source_resources.all<{ path: string; body: string }>({ workspace_id: workspaceId, scheme: "worker", target: null });
        const path = messages.find(({ body }) => body === "A shared assignment.")!.path;
        const run = (workerId: number, loopId: number, program: string) => engine.runTurn({
            messages: [], workspaceId, workerId, loopId,
            provider: new Mock({ contextWindow: 100000, responses: [makeRawMockResponse(program)] }),
        });
        await run(senderId, senderLoop, frame("NOTE", "Waiting for the answer."));
        await run(ownerId, ownerLoop, frame("NOTE", "Reviewing the assignment."));
        assert.equal((await run(responderId, responderLoop, frame(`SEND (${path})`, "Charlie's answer."))).status, 200);
        const history = await db.message_history.all<{ direction: string; body: string }>({ workspace_id: workspaceId, worker_id: ownerId, loop_id: ownerLoop });
        assert.deepEqual(history.filter(({ direction }) => direction === "outbound").map(({ body }) => body), ["Charlie's answer."]);
        const completed = await run(ownerId, ownerLoop, frame("NOTE", "The assignment was answered."));
        assert.equal(completed.status, 200);
        const result = await db.lifecycle_loop_status.get<{ terminal_result: string }>({ loop_id: ownerLoop });
        assert.equal(JSON.parse(result!.terminal_result).content, "Charlie's answer.");
        const observed = await run(senderId, senderLoop, frame("SEND", "Answer collected."));
        for (const turn of [completed, observed]) {
            const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: turn.turnId }))!.packet);
            const replies = logEntries(packet).filter(({ body }) => String(body).includes("Charlie's answer."));
            assert.equal(replies.length, 1);
        }
    } finally { await db.close(); }
});
