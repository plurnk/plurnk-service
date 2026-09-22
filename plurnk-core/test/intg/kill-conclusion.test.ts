import assert from "node:assert/strict";
import test from "node:test";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { Mock, type MockResponse } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { DEFAULT_MIMETYPES, insertLoop, insertWorker, insertWorkspace, openMigrated } from "./_helpers.ts";

const frame = PlurnkParser.frame;
const setup = async (responses: MockResponse[]) => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `kill-conclusion-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId, null, "alice");
    const loopId = await insertLoop(db, workerId, 1);
    const engine = new Engine({ db, schemes: new SchemeRegistry(), mimetypes: DEFAULT_MIMETYPES });
    await engine.injectIntoLoop(loopId, "Answer the question.", [], "agui://anonymous/threads/alice/messages/question");
    const provider = new Mock({ contextWindow: 100_000, responses });
    return { db, engine, provider, workspaceId, workerId, loopId,
        turn: () => engine.runTurn({ provider, workspaceId, workerId, loopId, messages: [] }),
        replies: async () => (await db.message_history.all<{ direction: string; body: string }>({
            workspace_id: workspaceId, worker_id: workerId, loop_id: loopId,
        })).filter(({ direction }) => direction === "outbound").map(({ body }) => body),
    };
};

test("{§operation-fences}: three-backtick EDIT, SEND and KILL use ordinary dispatch and completion", async () => {
    const f = await setup([
        { assistant: { content: "```EDIT (worker:///kept.md)\nRetained.\n```", reasoning: null } },
        { assistant: { content: "```SEND\nProgress delivered.\n```", reasoning: null } },
        { assistant: { content: "```KILL\nVerified.\n```", reasoning: null } },
    ]);
    try {
        for (const status of [102, 102, 200]) {
            const turn = await f.turn();
            assert.equal(turn.status, status);
            assert.equal(turn.emptyTurn, false, "accepted fences never become empty-turn recovery");
            const rows = await f.db.test_log_entries_by_turn.all<{ op: string; status_rx: number }>({ turn_id: turn.turnId });
            assert.equal(rows.some(({ status_rx }) => status_rx >= 400), false);
        }
        const channel = await f.db.test_get_channel_by_pathname.get<{ content: string }>({ pathname: "/kept.md", name: "body" });
        assert.equal(channel?.content, "Retained.");
        assert.deepEqual(await f.replies(), ["Progress delivered.", "Verified."]);
    } finally { await f.db.close(); }
});

for (const shape of ["nested", "indented"] as const) {
    test(`{§quotation}: ${shape} three-backtick deletion is delivered as text without deleting the entry`, async () => {
        const example = "```KILL (worker:///kept.md)\n```";
        const answer = `Example only:\n${example}\nDo not execute it.`;
        const source = shape === "nested" ? "```KILL\n" + answer + "\n```"
            : example.split("\n").map((line) => ` ${line}`).join("\n") + "\n\n```KILL\n```";
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
            assert.deepEqual(await f.replies(), [shape === "nested" ? answer : example.split("\n").map((line) => ` ${line}`).join("\n") + "\n\n"]);
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

for (const recovered of [false, true]) {
    test(`#809: ${recovered ? "interstitial text" : "parameterless SEND"} delivers but only KILL concludes`, async () => {
        const f = await setup([
            { assistant: { content: recovered ? "42." : frame("SEND", "42."), reasoning: null } },
            { assistant: { content: frame("KILL", ""), reasoning: null } },
        ]);
        try {
            const first = await f.turn();
            assert.equal(first.status, 102);
            assert.equal(first.emptyTurn, recovered);
            assert.deepEqual(await f.replies(), ["42."]);
            assert.equal((await f.turn()).status, 200);
            assert.deepEqual(await f.replies(), ["42."], "empty completion never repeats the answer");
        } finally { await f.db.close(); }
    });
}

for (const completionFirst of [false, true]) {
    test(`#809: mixed KILL ${completionFirst ? "before" : "after"} EDIT preserves the edit but does not publish a final answer`, async () => {
        const edit = frame("EDIT (worker:///answer)", "42");
        const kill = frame("KILL", "Unreviewed answer.");
        const f = await setup([
            { assistant: { content: (completionFirst ? [kill, edit] : [edit, kill]).join("\n\n"), reasoning: null } },
            { assistant: { content: frame("KILL", "Verified answer."), reasoning: null } },
        ]);
        try {
            const first = await f.turn();
            assert.equal(first.status, 102);
            assert.deepEqual(await f.replies(), []);
            const rows = await f.db.test_log_entries_by_turn.all<{ op: string; rx: string; status_rx: number }>({ turn_id: first.turnId });
            assert.equal(rows.find(({ op }) => op === "EDIT")?.status_rx, 201);
            assert.equal(rows.find(({ op }) => op === "KILL")?.status_rx, 102);
            assert.equal(JSON.parse(rows.find(({ op }) => op === "KILL")!.rx).detail, "Completion deferred. Conclude with KILL alone.");
            assert.equal((await f.turn()).status, 200);
            assert.deepEqual(await f.replies(), ["Verified answer."], "the deferred body is not silently replayed");
        } finally { await f.db.close(); }
    });
}

test("#809: empty KILL cannot discard an unanswered message", async () => {
    const f = await setup([{ assistant: { content: frame("KILL", ""), reasoning: null } }]);
    try {
        assert.equal((await f.turn()).status, 102);
        assert.deepEqual(await f.replies(), []);
    } finally { await f.db.close(); }
});

for (const completionFirst of [false, true]) {
    test(`#809: log curation ${completionFirst ? "after" : "before"} completion does not prevent an answered loop concluding`, async () => {
        const curate = frame("KILL (log:///**/NOTE)", "");
        const complete = frame("KILL", "42.");
        const f = await setup([
            { assistant: { content: frame("NOTE", "Disposable scratch."), reasoning: null } },
            { assistant: { content: (completionFirst ? [complete, curate] : [curate, complete]).join("\n\n"), reasoning: null } },
        ]);
        try {
            assert.equal((await f.turn()).status, 102);
            assert.equal((await f.turn()).status, 200);
            assert.deepEqual(await f.replies(), ["42."]);
            const rows = await f.db.engine_render_log.all<{ op: string }>({ worker_id: f.workerId });
            assert.equal(rows.some(({ op }) => op === "NOTE"), false, "the admitted curation executes before completion");
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
