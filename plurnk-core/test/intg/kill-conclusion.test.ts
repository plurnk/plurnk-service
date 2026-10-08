import assert from "node:assert/strict";
import test from "node:test";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { Mock, type MockResponse } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { DEFAULT_MIMETYPES } from "./_scheme.ts";
import { insertLoop, insertWorker, insertWorkspace, openMigrated } from "./_db.ts";

const frame = PlurnkParser.frame;
const setup = async (responses: MockResponse[]) => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `kill-conclusion-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId, null, "alice");
    const loopId = await insertLoop(db, workerId, 1);
    const notices: Array<{ kind: string; message?: string }> = [];
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES, noticeNotify: (_id, payload) => notices.push(payload.notice as { kind: string; message?: string }) });
    await engine.injectIntoLoop(loopId, "Answer the question.", [], "agui://anonymous/threads/alice/messages/question");
    const provider = new Mock({ contextWindow: 100_000, responses });
    return { db, engine, provider, workspaceId, workerId, loopId, notices,
        turn: () => engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] }),
        replies: async () => (await db.message_history.all<{ direction: string; body: string }>({
            workspace_id: workspaceId, worker_id: workerId, loop_id: loopId,
        })).filter(({ direction }) => direction === "outbound").map(({ body }) => body),
    };
};

// {§operation-fences} — the taught three-backtick fence opens the operation it names: it runs
// through ordinary dispatch and completion, and draws no receipt.
test("{§operation-fences}: three-backtick EDIT, SEND and KILL use ordinary dispatch and completion without a receipt", async () => {
    const f = await setup([
        { assistant: { content: "```EDIT (worker:///kept.md)\nRetained.\n```", reasoning: null } },
        { assistant: { content: "```SEND\nProgress delivered.\n```", reasoning: null } },
        { assistant: { content: "```KILL\nVerified.\n```", reasoning: null } },
    ]);
    try {
        for (const [op, status] of [["EDIT", 102], ["SEND", 102], ["KILL", 200]] as const) {
            const turn = await f.turn();
            assert.equal(turn.status, status, `${op} ran`);
            assert.equal(turn.emptyTurn, false, "accepted fences never become empty-turn recovery");
            const rows = await f.db.test_log_entries_by_turn.all<{ op: string; status_rx: number }>({ turn_id: turn.turnId });
            assert.equal(rows.some(({ status_rx }) => status_rx >= 400), false);
            assert.equal(f.notices.some(({ message }) => message?.includes("backticks") === true), false, `${op} drew no receipt about its fence`);
        }
        const channel = await f.db.test_get_channel_by_pathname.get<{ content: string }>({ pathname: "/kept.md", name: "body" });
        assert.equal(channel?.content, "Retained.");
        assert.deepEqual(await f.replies(), ["Progress delivered.", "Verified."]);
    } finally { await f.db.close(); }
});

test("{§naked-operation}: a bare KILL line concludes with everything beneath it as the delivered answer", async () => {
    const answer = "The answer is **42**.\n\n```diff\n-old\n+new\n```\n\nDone.";
    const f = await setup([{ assistant: { content: `KILL\n${answer}\n`, reasoning: null } }]);
    try {
        const turn = await f.turn();
        assert.equal(turn.status, 200, "the loop concluded");
        assert.equal(turn.emptyTurn, false);
        assert.deepEqual(await f.replies(), [answer], "the whole body, code block included, is the deliverable");
        assert.ok(f.notices.some(({ message }) => message === "`KILL` opened with no fence; the taught form is three backticks."), "the receipt names the taught form");
    } finally { await f.db.close(); }
});

test("{§naked-kill}: a recovered KILL with an aside delivers its deletion example without deleting the resource", async () => {
    const answer = "To delete the entry, use:\n\n````KILL (worker:///kept.md)\n````\n\nNothing was deleted.";
    const f = await setup([
        { assistant: { content: frame("EDIT (worker:///kept.md)", "Retained."), reasoning: null } },
        { assistant: { content: `KILL <!-- deliverable -->\n${answer}`, reasoning: null } },
    ]);
    try {
        assert.equal((await f.turn()).status, 102);
        const turn = await f.turn();
        const channel = await f.db.test_get_channel_by_pathname.get<{ content: string }>({ pathname: "/kept.md", name: "body" });
        assert.equal(channel?.content, "Retained.", "the quoted deletion never executes");
        assert.equal(turn.status, 200);
        assert.deepEqual(await f.replies(), [answer], "the complete example is delivered literally");
        assert.deepEqual(f.notices.filter(({ message }) => message?.includes("fence")).map(({ message }) => message),
            ["`KILL` opened with no fence; the taught form is three backticks."]);
    } finally { await f.db.close(); }
});

for (const shape of ["nested", "indented"] as const) {
    test(`{§quotation}: a ${shape} three-backtick deletion never deletes the entry`, async () => {
        const example = "```KILL (worker:///kept.md)\n```";
        const answer = `Example only:\n${example}\nDo not execute it.`;
        const source = shape === "nested" ? "```KILL\n" + answer + "\n```"
            : example.split("\n").map((line) => `\t${line}`).join("\n") + "\n\n```KILL\nDone.\n```";
        const f = await setup([
            { assistant: { content: "```EDIT (worker:///kept.md)\nRetained.\n```", reasoning: null } },
            { assistant: { content: source, reasoning: null } },
        ]);
        try {
            assert.equal((await f.turn()).status, 102);
            const turn = await f.turn();
            assert.equal(turn.status, 200);
            const channel = await f.db.test_get_channel_by_pathname.get<{ content: string }>({ pathname: "/kept.md", name: "body" });
            assert.equal(channel?.content, "Retained.", "quoted operations have no resource effect");
            assert.deepEqual(await f.replies(), [shape === "nested" ? answer : "Done."], "only a KILL body is delivered, never an example outside one");
            const rows = await f.db.test_log_entries_by_turn.all<{ op: string; status_rx: number }>({ turn_id: turn.turnId });
            assert.deepEqual(rows.filter(({ op }) => op === "KILL").map(({ status_rx }) => status_rx), [200]);
        } finally { await f.db.close(); }
    });
}

test("#809: parameterless KILL delivers its literal final answer and successfully concludes", async () => {
    const content = "The answer is **42**.\n\n```js\nconsole.log(42);\n```";
    const f = await setup([{ assistant: { content: frame("KILL", content), reasoning: null } }]);
    try {
        assert.equal((await f.turn()).status, 200);
        assert.deepEqual(await f.replies(), [content]);
    } finally { await f.db.close(); }
});

test("#809: parameterless SEND delivers but only KILL concludes", async () => {
    const f = await setup([
        { assistant: { content: frame("SEND", "42."), reasoning: null } },
        { assistant: { content: frame("KILL", ""), reasoning: null } },
    ]);
    try {
        const first = await f.turn();
        assert.equal(first.status, 102);
        assert.equal(first.emptyTurn, false);
        assert.deepEqual(await f.replies(), ["42."]);
        assert.equal((await f.turn()).status, 200);
        assert.deepEqual(await f.replies(), ["42."], "empty completion never repeats the answer");
    } finally { await f.db.close(); }
});

test("{§outside-text}: stray text answers nothing; a later explicit empty KILL concludes without delivering it", async () => {
    const f = await setup([
        { assistant: { content: "42.", reasoning: null } },
        { assistant: { content: frame("KILL", ""), reasoning: null } },
    ]);
    try {
        const first = await f.turn();
        assert.equal(first.status, 102);
        assert.equal(first.emptyTurn, true);
        assert.equal((await f.turn()).status, 200, "the authored KILL, not the stray text, concludes");
        assert.deepEqual(await f.replies(), [], "completion never promotes outside text into an answer");
    } finally { await f.db.close(); }
});

for (const completionFirst of [false, true]) {
    test(`{§terminal-kill}: EDIT ${completionFirst ? "after KILL is delivered literally without mutation" : "before KILL executes and defers completion"}`, async () => {
        const edit = frame("EDIT (worker:///answer)", "42");
        const kill = frame("KILL", "Unreviewed answer.");
        const content = (completionFirst ? [kill, edit] : [edit, kill]).join("\n\n");
        const f = await setup([
            { assistant: { content, reasoning: null } },
            { assistant: { content: frame("KILL", "Verified answer."), reasoning: null } },
        ]);
        try {
            const first = await f.turn();
            const channel = await f.db.test_get_channel_by_pathname.get<{ content: string }>({ pathname: "/answer", name: "body" });
            const rows = await f.db.test_log_entries_by_turn.all<{ op: string; rx: string; status_rx: number }>({ turn_id: first.turnId });
            if (completionFirst) {
                assert.equal(first.status, 200);
                assert.deepEqual(await f.replies(), [content.slice(content.indexOf("\n") + 1)]);
                assert.equal(channel, undefined, "an answer cannot execute its displayed EDIT");
                assert.deepEqual(rows.map(({ op, status_rx }) => [op, status_rx]), [["SEND", 200], ["READ", 200], ["KILL", 200]], "only ordinary answer delivery and completion have receipts");
                return;
            }
            assert.equal(first.status, 102);
            assert.deepEqual(await f.replies(), []);
            assert.equal(channel?.content, "42");
            assert.equal(rows.find(({ op }) => op === "EDIT")?.status_rx, 201);
            assert.equal(rows.find(({ op }) => op === "KILL")?.status_rx, 102);
            assert.equal(JSON.parse(rows.find(({ op }) => op === "KILL")!.rx).detail, "Completion deferred. Conclude with KILL alone."); // {§pinned-wording-core}
            assert.equal((await f.turn()).status, 200);
            assert.deepEqual(await f.replies(), ["Verified answer."], "the deferred body is not silently replayed");
        } finally { await f.db.close(); }
    });
}

for (const body of [null, "", " \n\t"]) test(`{§kill-conclusion}: KILL with body ${JSON.stringify(body)} concludes without inventing a reply`, async () => {
    const f = await setup([{ assistant: { content: frame("KILL", body), reasoning: null } }]);
    try {
        const turn = await f.turn();
        assert.equal(turn.status, 200);
        assert.equal(turn.emptyTurn, false, "an explicit KILL is not an empty provider turn");
        assert.equal(await new LoopLifecycle(f.db).status(f.loopId), 200, "completion is durable");
        assert.deepEqual(await f.replies(), []);
        const history = await f.db.message_history.all<{ direction: string; body: string }>({
            workspace_id: f.workspaceId, worker_id: f.workerId, loop_id: f.loopId,
        });
        assert.deepEqual(history.map(({ direction, body }) => ({ direction, body })), [
            { direction: "inbound", body: "Answer the question." },
        ], "silent completion retains the input without fabricating delivery");
        assert.equal((await f.db.message_unanswered_count.get({ loop_id: f.loopId }))?.count, 1, "historical delivery evidence stays truthful");
    } finally { await f.db.close(); }
});

for (const stage of ["inference", "terminal transition"] as const) {
    test(`{§completion-defers-to-messages}: empty KILL cannot skip a message arriving during ${stage}`, async (t) => {
        const f = await setup([0, 1].map(() => ({ assistant: { content: frame("KILL", null), reasoning: null } })));
        let injected = false;
        const inject = async () => {
            if (injected) return;
            injected = true;
            await f.engine.injectIntoLoop(f.loopId, "A later request.");
        };
        if (stage === "inference") {
            const generate = f.provider.generate.bind(f.provider);
            t.mock.method(f.provider, "generate", async (...args: Parameters<Mock["generate"]>) => {
                await inject();
                return generate(...args);
            });
        } else {
            const finish = LoopLifecycle.prototype.finish;
            t.mock.method(LoopLifecycle.prototype, "finish", async function (this: LoopLifecycle, ...args: Parameters<LoopLifecycle["finish"]>) {
                if (args[0] === f.loopId) await inject();
                return finish.apply(this, args);
            });
        }
        try {
            assert.equal((await f.turn()).status, 102, "the unseen arrival prevents completion");
            assert.equal((await f.turn()).status, 200, "after observation, explicit silent completion is permitted");
            assert.match(JSON.stringify(f.provider.received[1]), /A later request\./u);
            assert.deepEqual(await f.replies(), []);
        } finally { await f.db.close(); }
    });
}

for (const completionFirst of [false, true]) {
    test(`{§terminal-kill}: log curation ${completionFirst ? "after KILL is answer text" : "before KILL executes without preventing completion"}`, async () => {
        const curate = frame("KILL (log:///**/NOTE)", "");
        const complete = frame("KILL", "42.");
        const content = (completionFirst ? [complete, curate] : [curate, complete]).join("\n\n");
        const f = await setup([
            { assistant: { content: frame("NOTE", "Disposable scratch."), reasoning: null } },
            { assistant: { content, reasoning: null } },
        ]);
        try {
            assert.equal((await f.turn()).status, 102);
            assert.equal((await f.turn()).status, 200);
            assert.deepEqual(await f.replies(), [completionFirst ? content.slice(content.indexOf("\n") + 1) : "42."]);
            const rows = await f.db.engine_render_log.all<{ op: string }>({ worker_id: f.workerId });
            assert.equal(rows.some(({ op }) => op === "NOTE"), completionFirst, "only curation before the final answer executes");
        } finally { await f.db.close(); }
    });
}

test("#809: reasoning NOTE does not prevent an otherwise lone KILL", async () => {
    const f = await setup([{ assistant: { content: frame("KILL", "42."), reasoning: frame("NOTE", "Arithmetic verified.") } }]);
    try {
        assert.equal((await f.turn()).status, 200);
        assert.deepEqual(await f.replies(), ["42."]);
    } finally { await f.db.close(); }
});

for (const [header, status] of [
    ["SEND (reasoning://alice/1/1)", 400],
    ["KILL (log:///9/9/9)", 404],
] as const) {
    test(`{§kill-conclusion}: a failed tolerated sibling (${header}) prevents final delivery`, async () => {
        const f = await setup([
            { assistant: { content: `${frame(header, null)}\n\n${frame("KILL", "Premature.")}`, reasoning: null } },
            { assistant: { content: frame("KILL", "Reviewed."), reasoning: null } },
        ]);
        try {
            const first = await f.turn();
            assert.equal(first.status, 102);
            assert.deepEqual(await f.replies(), []);
            const rows = await f.db.test_log_entries_by_turn.all<{ status_rx: number }>({ turn_id: first.turnId });
            assert.ok(rows.some(({ status_rx }) => status_rx === status), "the failed sibling remains visible");
            assert.equal((await f.turn()).status, 200);
            assert.deepEqual(await f.replies(), ["Reviewed."]);
        } finally { await f.db.close(); }
    });
}

test("{§kill-conclusion}: the operation limit prevents final delivery when tolerated siblings were omitted", async () => {
    const previous = process.env.PLURNK_SERVICE_MAX_COMMANDS;
    process.env.PLURNK_SERVICE_MAX_COMMANDS = "1";
    const f = await setup([
        { assistant: { content: [frame("NOTE", "Kept."), frame("NOTE", "Omitted."), frame("KILL", "Premature.")].join("\n\n"), reasoning: null } },
        { assistant: { content: frame("KILL", "Reviewed."), reasoning: null } },
    ]);
    try {
        const first = await f.turn();
        assert.equal(first.status, 102);
        assert.deepEqual(await f.replies(), [], "the omitted operation's failure must precede final delivery");
        const rows = await f.db.test_log_entries_by_turn.all<{ op: string; status_rx: number; rx: string }>({ turn_id: first.turnId });
        assert.equal(rows.find(({ op }) => op === "KILL")?.status_rx, 102);
        assert.ok(rows.some(({ status_rx, rx }) => status_rx === 429 && JSON.parse(rx).problem?.omittedOperations === 1));
        assert.equal((await f.turn()).status, 200);
        assert.deepEqual(await f.replies(), ["Reviewed."]);
    } finally {
        await f.db.close();
        if (previous === undefined) delete process.env.PLURNK_SERVICE_MAX_COMMANDS;
        else process.env.PLURNK_SERVICE_MAX_COMMANDS = previous;
    }
});
