import assert from "node:assert/strict";
import test from "node:test";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { Mock, type MockResponse } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import { DEFAULT_MIMETYPES } from "./_scheme.ts";
import { holdChild, insertLoop, insertWorker, insertWorkspace, openMigrated, seedEntryWithChannel } from "./_db.ts";

const frame = (heading: string, body: string | null = null) => PlurnkParser.frame(heading, body);
const setup = async () => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `message-completion-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId, null, "alice");
    const loopId = await insertLoop(db, workerId, 1);
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
    const ids = { workspaceId, workerId, loopId };
    const message = (name: string) => `message://alice/${name}`;
    const add = (name: string) => engine.injectIntoLoop(loopId, `Request ${name}.`, [], undefined, {}, message(name));
    await add("first");
    const turn = (content: string, reasoning: string | null = null, finishReason: NonNullable<MockResponse["assistant"]>["finishReason"] = "stop") => engine.runTurn({
        ...ids, messages: [],
        provider: new Mock({ contextWindow: 100_000, responses: [{ assistant: { content, reasoning, finishReason } }] }),
    });
    const remaining = async () => (await db.message_unanswered_count.get<{ count: number }>({ loop_id: loopId }))!.count;
    const replies = async () => (await db.message_history.all<{ direction: string; body: string }>({
        workspace_id: workspaceId, worker_id: workerId, loop_id: loopId,
    })).filter(({ direction }) => direction === "outbound").map(({ body }) => body);
    return { db, engine, ids, message, add, turn, remaining, replies };
};

test("{§message-completion}: progress delivers without resolving; explicit completion concludes", async (t) => {
    const f = await setup(); t.after(() => f.db.close());
    assert.equal((await f.turn(frame(`SEND (${f.message("first")})`, "Working."))).status, 102);
    assert.deepEqual(await f.replies(), ["Working."]);
    assert.equal(await f.remaining(), 1);
    assert.equal((await f.turn(frame("SEND [200]", "Finished."))).status, 200);
    assert.equal(await f.remaining(), 0);
    assert.deepEqual(await f.replies(), ["Working.", "Finished."]);
});

test("{§message-completion}: two independent final replies execute in one turn", async (t) => {
    const f = await setup(); t.after(() => f.db.close());
    await f.add("second");
    const completed = await f.turn([
        frame(`SEND (${f.message("first")}) [200]`, "First answer."),
        frame(`SEND (${f.message("second")}) [200]`, "Second answer."),
    ].join("\n\n"));
    assert.equal(completed.status, 200);
    assert.equal(await f.remaining(), 0);
    assert.deepEqual(await f.replies(), ["First answer.", "Second answer."]);
});

for (const count of [0, 1, 2]) {
    for (const metadata of ["", " [200]", " [499]"]) {
        test(`{§message-completion}: targetless SEND${metadata} with ${count} Open Messages`, async (t) => {
            const f = await setup(); t.after(() => f.db.close());
            await seedEntryWithChannel(f.db, { workspaceId: f.ids.workspaceId, pathname: "/evidence.txt", content: "Evidence." });
            if (count === 0) await f.turn(`${frame("READ (worker:///evidence.txt)")}\n\n${frame(`SEND (${f.message("first")}) [200]`, "First answer.")}`);
            if (count === 2) await f.add("second");
            const before = await f.replies();
            const result = await f.turn(frame(`SEND${metadata}`, "Implicit reply."));
            const delivery = result.outcomes.find(({ op }) => op === "SEND");
            assert.equal(delivery?.status, 200);
            assert.equal(await f.remaining(), count > 0 && metadata !== "" ? count - 1 : count);
            assert.deepEqual(await f.replies(), [...before, "Implicit reply."]);
            const rows = await f.db.test_log_entries_by_turn.all<{ op: string; origin: string; rx: string }>({ turn_id: result.turnId });
            const reply = rows.find(({ op, origin }) => op === "SEND" && origin === "model");
            assert.deepEqual(JSON.parse(reply!.rx).answers, [f.message("first")]);
            if (count === 0) {
                assert.equal(JSON.parse(reply!.rx).completion, undefined, "with none open, the reply is speech only");
                assert.equal((await f.db.message_completion_outcome.get<{ status: number }>({ loop_id: f.ids.loopId }))!.status, 200,
                    "the completed message keeps its outcome");
            }
        });
    }
}

test("{§message-completion}: a targetless SEND in a loop with no published message is refused", async (t) => {
    const db = await openMigrated(); t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, `message-completion-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId, null, "bob");
    const loopId = await insertLoop(db, workerId, 1);
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
    const result = await engine.runTurn({ workspaceId, workerId, loopId, messages: [],
        provider: new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: frame("SEND", "Hello?"), reasoning: null, finishReason: "stop" } }] }) });
    const delivery = result.outcomes.find(({ op }) => op === "SEND");
    assert.equal(delivery?.status, 400);
    assert.equal(delivery?.problemType, "https://problems.plurnk.xyz/engine/dispatcher/send-target-required");
});

test("{§message-completion}: progress and consecutive completions consume the queue in authored order", async (t) => {
    const f = await setup(); t.after(() => f.db.close());
    await f.add("second");
    const result = await f.turn([
        frame("SEND", "First progress."),
        frame("SEND [200]", "First answer."),
        frame("SEND", "Second progress."),
        frame("SEND [499]", "Second cancelled."),
    ].join("\n\n"));
    assert.equal(result.status, 200);
    assert.equal(await f.remaining(), 0);
    const rows = await f.db.test_log_entries_by_turn.all<{ op: string; origin: string; rx: string }>({ turn_id: result.turnId });
    assert.deepEqual(rows.filter(({ op, origin }) => op === "SEND" && origin === "model").map(({ rx }) => JSON.parse(rx).answers),
        [[f.message("first")], [f.message("first")], [f.message("second")], [f.message("second")]]);
});

test("{§message-completion}: corrections name an already-resolved message explicitly", async (t) => {
    const f = await setup(); t.after(() => f.db.close());
    await seedEntryWithChannel(f.db, { workspaceId: f.ids.workspaceId, pathname: "/evidence.txt", content: "New evidence." });
    assert.equal((await f.turn(`${frame("READ (worker:///evidence.txt)")}\n\n${frame("SEND [200]", "Initial answer.")}`)).status, 102);
    assert.equal((await f.turn(frame(`SEND (${f.message("first")}) [200]`, "Corrected answer."))).status, 200);
    assert.deepEqual(await f.replies(), ["Initial answer.", "Corrected answer."]);
});

for (const tail of ["", frame("NOTE", "The result is sufficient."), frame("KILL (log:///**/READ)", "Retired inspected evidence.")]) {
    test(`{§loop-completion}: late results retain the answer and settle after ${tail || "no further operations"}`, async (t) => {
        const f = await setup(); t.after(() => f.db.close());
        await seedEntryWithChannel(f.db, { workspaceId: f.ids.workspaceId, scheme: "worker", pathname: "/evidence.txt",
            channel: "body", content: "Late evidence.", mimetype: "text/plain", state: "static" });
        const first = await f.turn([frame("READ (worker:///evidence.txt)"), frame("SEND [200]", "The deliverable.")].join("\n\n"));
        assert.equal(first.status, 102, "the READ receipt requires an observation turn");
        assert.equal(await f.remaining(), 0, "the delivered final reply resolved its messages already");
        assert.deepEqual(await f.replies(), ["The deliverable."], "the answer is not withheld");
        assert.equal((await f.turn(tail)).status, 200);
        assert.deepEqual(await f.replies(), ["The deliverable."], "settlement neither repeats nor erases the answer");
    });
}

test("{§loop-completion}: empty output with an unresolved message is recovery", async (t) => {
    const f = await setup(); t.after(() => f.db.close());
    const result = await f.turn("");
    assert.equal(result.status, 102);
    assert.equal(result.emptyTurn, true);
    assert.equal(await f.remaining(), 1);
});

test("{§message-completion}: empty completion resolves without replacing earlier speech", async (t) => {
    const f = await setup(); t.after(() => f.db.close());
    await f.turn(frame(`SEND (${f.message("first")})`, "Delivered answer."));
    assert.equal((await f.turn(frame("SEND [200]"))).status, 200);
    assert.equal(await f.remaining(), 0);
    assert.deepEqual((await f.replies()).filter(Boolean), ["Delivered answer."]);
});

test("{§loop-completion}: new operations after final replies create new observation obligations", async (t) => {
    const f = await setup(); t.after(() => f.db.close());
    await seedEntryWithChannel(f.db, { workspaceId: f.ids.workspaceId, scheme: "worker", pathname: "/evidence.txt",
        channel: "body", content: "Inspect again.", mimetype: "text/plain", state: "static" });
    const read = frame("READ (worker:///evidence.txt)");
    assert.equal((await f.turn(`${frame("SEND [200]", "Answer.")}\n\n${read}`)).status, 102);
    assert.equal((await f.turn(read)).status, 102);
    assert.equal((await f.turn("")).status, 200);
});

test("{§loop-completion}: final replies join held work without cancelling it", async (t) => {
    const f = await setup(); t.after(() => f.db.close());
    const childLoop = await holdChild(f.db, f.ids.workspaceId, f.ids.workerId);
    assert.equal((await f.turn(frame("SEND [200]", "Answer while the child finishes."))).status, 202);
    assert.equal(await f.remaining(), 0);
    assert.equal((await f.db.lifecycle_loop_status.get<{ status: number }>({ loop_id: childLoop }))!.status, 102);
});

for (const code of [200, 499]) {
    test(`{§message-completion}: [${code}] leaves child and stream work alive until normal settlement`, async (t) => {
        const f = await setup(); t.after(() => f.db.close());
        const childLoop = await holdChild(f.db, f.ids.workspaceId, f.ids.workerId);
        const entry = await seedEntryWithChannel(f.db, { workspaceId: f.ids.workspaceId, scheme: "sh", pathname: "/live", channel: "stdout", state: "active" });
        const stream = await f.db.open_subscription.get<{ id: number }>({ worker_id: f.ids.workerId, entry_id: entry, scheme: "sh", handle: "fixture-live" });
        assert.ok(stream);
        const held = () => f.db.worker_live_obligations.get<{ streams: number; workers: number }>({ worker_id: f.ids.workerId });
        assert.equal((await f.turn(frame(`SEND [${code}]`, "Outcome delivered."))).status, 202);
        assert.deepEqual(await held(), { streams: 1, workers: 1 }, "message resolution cancels neither obligation");
        const lifecycle = new LoopLifecycle(f.db);
        await lifecycle.finish(childLoop, { status: 200 });
        await f.db.close_subscription.run({ subscription_id: stream.id, status: 200, result: JSON.stringify({ status: 200 }), channel_results: "{}" });
        assert.deepEqual(await held(), { streams: 0, workers: 0 });
        assert.equal(await lifecycle.wake(f.ids.loopId), true);
        assert.equal((await f.db.drain_claim_next_loop.get<{ id: number }>({ worker_id: f.ids.workerId }))?.id, f.ids.loopId);
        assert.equal((await f.turn("")).status, code, "the next packet observes normal settlement before the message outcome concludes the loop");
        assert.equal(await lifecycle.status(childLoop), 200, "parent cancellation does not rewrite the child's success");
    });
}

test("{§message-completion}: an attachment-only completion retains its deliverable", async (t) => {
    const f = await setup(); t.after(() => f.db.close());
    await seedEntryWithChannel(f.db, { workspaceId: f.ids.workspaceId, pathname: "/report.txt", content: "Final report." });
    assert.equal((await f.turn(frame('SEND [200,{"attachments":["worker:///report.txt"]}]'))).status, 200);
    assert.equal(await f.remaining(), 0);
    const history = await f.db.message_history.all<{ direction: string; body: string; evidence: string }>({
        workspace_id: f.ids.workspaceId, worker_id: f.ids.workerId, loop_id: f.ids.loopId,
    });
    const replies = history.filter(({ direction }) => direction === "outbound");
    assert.equal(replies.length, 1);
    assert.equal(replies[0]!.body, "");
    assert.deepEqual(JSON.parse(replies[0]!.evidence).attachments.map(({ target, name }: { target: string; name: string }) => ({ target, name })),
        [{ target: "worker:///report.txt", name: "report.txt" }]);
});

test("{§message-completion}: a later request stays open after an earlier final reply", async (t) => {
    const f = await setup(); t.after(() => f.db.close());
    await f.add("second");
    assert.equal((await f.turn(frame(`SEND (${f.message("first")}) [200]`, "First answer."))).status, 102);
    assert.equal(await f.remaining(), 1);
    assert.equal((await f.turn("")).status, 102);
    assert.equal((await f.turn(frame(`SEND (${f.message("second")}) [200]`, "Second answer."))).status, 200);
});

for (const [codes, expected] of [[[499, 499], 499], [[499, 200], 200], [[200, 499], 200]] as const) {
    test(`{§message-completion}: message outcomes ${codes.join("+")} settle as ${expected}`, async (t) => {
        const f = await setup(); t.after(() => f.db.close());
        await f.add("second");
        const result = await f.turn([
            frame(`SEND (${f.message("first")}) [${codes[0]}]`, "First outcome."),
            frame(`SEND (${f.message("second")}) [${codes[1]}]`, "Second outcome."),
        ].join("\n\n"));
        assert.equal(result.status, expected);
        assert.equal(await f.remaining(), 0);
        assert.deepEqual(await f.replies(), ["First outcome.", "Second outcome."]);
    });
}

test("{§message-completion}: a corrected completion wins without ordinary progress reopening it", async (t) => {
    const f = await setup(); t.after(() => f.db.close());
    await f.add("second");
    await f.turn(frame(`SEND (${f.message("first")}) [499]`, "Cannot yet deliver."));
    await f.turn(frame(`SEND (${f.message("first")}) [200]`, "Found the answer."));
    await f.turn(frame(`SEND (${f.message("first")})`, "Additional context."));
    assert.equal(await f.remaining(), 1);
    assert.equal((await f.turn(frame(`SEND (${f.message("second")}) [499]`, "Cancelled."))).status, 200);
});

for (const invalid of ["[201]", "[500]", "[200,499]", '["200"]', '[200,{"attachments":["worker:///missing.pdf"]}]']) {
    test(`{§message-completion}: failed reply ${invalid} leaves its message unresolved`, async (t) => {
        const f = await setup(); t.after(() => f.db.close());
        const result = await f.turn(frame(`SEND ${invalid}`, "Not delivered."));
        assert.equal(result.status, 102);
        assert.ok(result.outcomes.some(({ status }) => status >= 400));
        assert.equal(await f.remaining(), 1);
        assert.deepEqual(await f.replies(), []);
    });
}

for (const finishReason of ["length", "content_filter", "tool_calls"] as const) {
    test(`{§loop-completion}: ${finishReason} cannot close an otherwise resolved loop`, async (t) => {
        const f = await setup(); t.after(() => f.db.close());
        await seedEntryWithChannel(f.db, { workspaceId: f.ids.workspaceId, scheme: "worker", pathname: "/evidence.txt",
            channel: "body", content: "Evidence.", mimetype: "text/plain", state: "static" });
        await f.turn(`${frame("READ (worker:///evidence.txt)")}\n\n${frame("SEND [200]", "Answer.")}`);
        assert.equal((await f.turn("", "", finishReason)).status, 102);
        assert.equal((await f.turn("")).status, 200);
    });
}

for (const content of [
    "READ (worker:///evidence.txt)",
    '<tool_call><function=READ><parameter=unknown>evidence.txt</parameter></function></tool_call>',
    frame("reed (worker:///evidence.txt)"),
    `${frame("NOTE", "Inspect more evidence.")}\n\nREAD (worker:///evidence.txt)`,
]) {
    test(`{§loop-completion}: omitted operation cannot certify settlement: ${content}`, async (t) => {
        const f = await setup(); t.after(() => f.db.close());
        await seedEntryWithChannel(f.db, { workspaceId: f.ids.workspaceId, pathname: "/evidence.txt", content: "Evidence." });
        assert.equal((await f.turn(`${frame("READ (worker:///evidence.txt)")}\n\n${frame("SEND [200]", "Answer.")}`)).status, 102);
        assert.equal((await f.turn(content)).status, 102, "omitted work requires another opportunity to act");
        assert.equal((await f.turn("")).status, 200, "the diagnostic does not create a lasting acknowledgement state");
    });
}

test("{§loop-completion}: an admitted syntax recovery does not withhold completion", async (t) => {
    const f = await setup(); t.after(() => f.db.close());
    const result = await f.turn("````\nSEND [200]\nAnswer.\n````");
    assert.equal(result.status, 200);
    assert.deepEqual(await f.replies(), ["Answer."]);
});
