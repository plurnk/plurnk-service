import assert from "node:assert/strict";
import test from "node:test";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { Mock, type MockResponse } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { DEFAULT_MIMETYPES } from "./_scheme.ts";
import { insertLoop, insertWorker, insertWorkspace, openMigrated } from "./_db.ts";

const frame = (heading: string, body: string | null = null) => PlurnkParser.frame(heading, body);
const response = (content: string, reasoning: string | null = null): MockResponse => ({ assistant: { content, reasoning } });
const setup = async (responses: MockResponse[]) => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `reply-completion-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId, null, "alice");
    const loopId = await insertLoop(db, workerId, 1);
    const notices: Array<{ kind: string; message?: string }> = [];
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES, noticeNotify: (_id, payload) => notices.push(payload.notice as { kind: string; message?: string }) });
    await engine.injectIntoLoop(loopId, "Answer the question.", [], "agui://anonymous/threads/alice/messages/question");
    const provider = new Mock({ contextWindow: 100_000, responses });
    return { db, engine, provider, workspaceId, workerId, loopId, notices,
        turn: () => engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] }),
        history: () => db.message_history.all<{ direction: string; body: string }>({ workspace_id: workspaceId, worker_id: workerId, loop_id: loopId }),
    };
};
const speech = async (f: Awaited<ReturnType<typeof setup>>) => (await f.history())
    .filter(({ direction, body }) => direction === "outbound" && body.trim().length > 0).map(({ body }) => body);

test("{§operation-fences}: ordinary EDIT, progress SEND and final SEND execute without framing notices", async (t) => {
    const f = await setup([
        response(frame("EDIT (worker:///kept.md)", "Retained.")),
        response(frame("SEND", "Progress delivered.")),
        response(frame("SEND [200]", "Verified.")),
    ]);
    t.after(() => f.db.close());
    for (const status of [102, 102, 200]) {
        const turn = await f.turn();
        assert.equal(turn.status, status);
        assert.equal(turn.emptyTurn, false);
        const rows = await f.db.test_log_entries_by_turn.all<{ status_rx: number }>({ turn_id: turn.turnId });
        assert.equal(rows.some(({ status_rx }) => status_rx >= 400), false);
    }
    assert.equal(f.notices.some(({ message }) => message?.includes("backticks")), false);
    assert.equal((await f.db.test_get_channel_by_pathname.get({ pathname: "/kept.md", name: "body" }))?.content, "Retained.");
    assert.deepEqual(await speech(f), ["Progress delivered.", "Verified."]);
});

for (const shape of ["nested", "indented"] as const) {
    test(`{§quotation}: a ${shape} deletion example is not executed`, async (t) => {
        const example = frame("KILL (worker:///kept.md)");
        const answer = `Example only:\n${example}\nNothing was deleted.`;
        const content = shape === "nested" ? frame("SEND [200]", answer)
            : example.split("\n").map((line) => `\t${line}`).join("\n") + "\n\n" + frame("SEND [200]", "Done.");
        const f = await setup([response(frame("EDIT (worker:///kept.md)", "Retained.")), response(content)]);
        t.after(() => f.db.close());
        assert.equal((await f.turn()).status, 102);
        const final = await f.turn();
        assert.equal(final.status, 200);
        assert.equal((await f.db.test_get_channel_by_pathname.get({ pathname: "/kept.md", name: "body" }))?.content, "Retained.");
        assert.deepEqual(await speech(f), [shape === "nested" ? answer : "Done."]);
        assert.equal((await f.db.test_log_entries_by_turn.all<{ op: string }>({ turn_id: final.turnId })).some(({ op }) => op === "KILL"), false);
    });
}

test("{§outside-text}: rejected prose is not silently promoted by a later completion", async (t) => {
    const f = await setup([response("42."), response(frame("SEND [200]"))]);
    t.after(() => f.db.close());
    const first = await f.turn();
    assert.equal(first.status, 102);
    assert.equal(first.emptyTurn, true);
    assert.equal((await f.turn()).status, 200);
    assert.deepEqual(await speech(f), []);
});

for (const completionFirst of [false, true]) {
    test(`{§loop-completion}: EDIT ${completionFirst ? "after" : "before"} a final reply still runs and requires observation`, async (t) => {
        const edit = frame("EDIT (worker:///answer)", "42");
        const reply = frame("SEND [200]", "Delivered answer.");
        const f = await setup([response((completionFirst ? [reply, edit] : [edit, reply]).join("\n\n")), response("")]);
        t.after(() => f.db.close());
        const first = await f.turn();
        assert.equal(first.status, 102);
        assert.deepEqual(await speech(f), ["Delivered answer."], "delivery does not wait for observation");
        assert.equal((await f.db.test_get_channel_by_pathname.get({ pathname: "/answer", name: "body" }))?.content, "42");
        assert.ok(f.notices.some(({ message }) => message === "All Open Messages resolved. Review new results; emit no OPs if finished."));
        assert.equal((await f.turn()).status, 200);
        assert.deepEqual(await speech(f), ["Delivered answer."], "settlement does not replay the reply");
    });

    test(`{§loop-completion}: curation ${completionFirst ? "after" : "before"} completion runs without extending the loop`, async (t) => {
        const curate = frame("KILL (log:///**/NOTE)");
        const reply = frame("SEND [200]", "42.");
        const f = await setup([response(frame("NOTE", "Disposable scratch.")), response((completionFirst ? [reply, curate] : [curate, reply]).join("\n\n"))]);
        t.after(() => f.db.close());
        assert.equal((await f.turn()).status, 102);
        assert.equal((await f.turn()).status, 200);
        assert.deepEqual(await speech(f), ["42."]);
        assert.equal((await f.db.engine_render_log.all<{ op: string }>({ worker_id: f.workerId })).some(({ op }) => op === "NOTE"), false);
    });
}

for (const body of [null, "", " \n\t"]) {
    test(`{§message-completion}: empty reply ${JSON.stringify(body)} resolves without inventing speech`, async (t) => {
        const f = await setup([response(frame("SEND [200]", body))]);
        t.after(() => f.db.close());
        const turn = await f.turn();
        assert.equal(turn.status, 200);
        assert.equal(turn.emptyTurn, false);
        assert.equal(await new LoopLifecycle(f.db).status(f.loopId), 200);
        assert.deepEqual(await speech(f), []);
        assert.deepEqual((await f.history()).filter(({ direction }) => direction === "inbound").map(({ body }) => body), ["Answer the question."]);
        assert.deepEqual((await f.history()).filter(({ direction }) => direction === "outbound"), [], "the completion fact is not an empty conversation message");
        assert.equal((await f.db.message_unanswered_count.get({ loop_id: f.loopId }))?.count, 0);
    });
}

for (const stage of ["inference", "terminal transition"] as const) {
    test(`{§completion-defers-to-messages}: a reply cannot resolve an unseen message arriving during ${stage}`, async (t) => {
        const f = await setup([response(frame("SEND [200]")), response(frame("SEND [200]"))]);
        t.after(() => f.db.close());
        let injected = false;
        const inject = async () => {
            if (injected) return;
            injected = true;
            await f.engine.injectIntoLoop(f.loopId, "A later request.");
        };
        if (stage === "inference") {
            const generate = f.provider.generate.bind(f.provider);
            t.mock.method(f.provider, "generate", async (...args: Parameters<Mock["generate"]>) => { await inject(); return generate(...args); });
        } else {
            const finish = LoopLifecycle.prototype.finish;
            t.mock.method(LoopLifecycle.prototype, "finish", async function (this: LoopLifecycle, ...args: Parameters<LoopLifecycle["finish"]>) {
                if (args[0] === f.loopId) await inject();
                return finish.apply(this, args);
            });
        }
        assert.equal((await f.turn()).status, 102);
        assert.equal((await f.db.message_unanswered_count.get({ loop_id: f.loopId }))?.count, 1);
        assert.equal((await f.turn()).status, 200);
        assert.match(JSON.stringify(f.provider.received[1]), /A later request\./u);
        assert.deepEqual(await speech(f), []);
    });
}

test("{§loop-completion}: a reasoning NOTE does not extend a resolved loop", async (t) => {
    const f = await setup([response(frame("SEND [200]", "42."), frame("NOTE", "Arithmetic verified."))]);
    t.after(() => f.db.close());
    assert.equal((await f.turn()).status, 200);
    assert.deepEqual(await speech(f), ["42."]);
});

for (const [header, status] of [["SEND (reasoning://alice/1/1)", 400], ["KILL (log:///9/9/9)", 404]] as const) {
    test(`{§loop-completion}: failure of ${header} requires observation but never withholds a successful reply`, async (t) => {
        const f = await setup([response(`${frame(header)}\n\n${frame("SEND [200]", "Answer.")}`), response("")]);
        t.after(() => f.db.close());
        const first = await f.turn();
        assert.equal(first.status, 102);
        assert.deepEqual(await speech(f), ["Answer."]);
        assert.ok((await f.db.test_log_entries_by_turn.all<{ status_rx: number }>({ turn_id: first.turnId })).some(({ status_rx }) => status_rx === status));
        assert.equal((await f.turn()).status, 200);
    });
}

test("{§loop-completion}: omitted operations prevent settlement and an omitted reply resolves nothing", async (t) => {
    const previous = process.env.PLURNK_SERVICE_MAX_COMMANDS;
    process.env.PLURNK_SERVICE_MAX_COMMANDS = "1";
    t.after(() => { if (previous === undefined) delete process.env.PLURNK_SERVICE_MAX_COMMANDS; else process.env.PLURNK_SERVICE_MAX_COMMANDS = previous; });
    const f = await setup([response([frame("NOTE", "Kept."), frame("NOTE", "Omitted."), frame("SEND [200]", "Not delivered.")].join("\n\n")), response(frame("SEND [200]", "Reviewed."))]);
    t.after(() => f.db.close());
    const first = await f.turn();
    assert.equal(first.status, 102);
    assert.deepEqual(await speech(f), []);
    assert.equal((await f.db.message_unanswered_count.get({ loop_id: f.loopId }))?.count, 1);
    assert.ok((await f.db.test_log_entries_by_turn.all<{ status_rx: number; rx: string }>({ turn_id: first.turnId }))
        .some(({ status_rx, rx }) => status_rx === 429 && JSON.parse(rx).problem?.omittedOperations === 2));
    assert.equal((await f.turn()).status, 200);
    assert.deepEqual(await speech(f), ["Reviewed."]);
});
