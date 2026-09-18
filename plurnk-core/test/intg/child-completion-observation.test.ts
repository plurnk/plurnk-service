import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import Results from "../../src/core/results.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, insertTurn, logEntries } from "./_helpers.ts";

const frame = (op: string, body = "") => `\`\`\`\`${op}\n${body}\n\`\`\`\``;

const fixture = async () => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, "completion-observation");
    const parent = await insertWorker(db, workspaceId, null, "parent");
    const parentLoop = await insertLoop(db, parent, 1, "Collect the child's answer.");
    const child = await insertWorker(db, workspaceId, parent, "child");
    const childLoop = await insertLoop(db, child, 1);
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    const lifecycle = new LoopLifecycle(db);
    const run = async (workerId: number, loopId: number, content = frame("NOTE", "Observed.")) => {
        const result = await engine.runTurn({
            messages: [], workspaceId, workerId, loopId,
            provider: new Mock({ contextWindow: 100_000, responses: [{ assistant: { content, reasoning: null } }] }),
        });
        const packet = JSON.parse((await db.test_get_packet.get<{ packet: string }>({ id: result.turnId }))!.packet);
        return { result, packet, entries: logEntries(packet) };
    };
    return { db, workspaceId, parent, parentLoop, child, childLoop, engine, lifecycle, run };
};

for (const outcome of ["success", "failure", "cancel"] as const) {
    test(`{§env-delta-child-termination}: ${outcome} after a reply is a READ, never another SEND`, async (t) => {
        const f = await fixture();
        t.after(() => f.db.close());
        await f.engine.injectIntoLoop(f.childLoop, "What did you find?", [], "worker://parent");
        await f.run(f.child, f.childLoop, frame("SEND", "The answer is 42.") + "\n\n" + frame("FIND (*)"));
        const before = await f.run(f.parent, f.parentLoop);
        const reply = before.entries.filter(({ answers }) => Array.isArray(answers));
        assert.equal(reply.length, 1);
        assert.match(String(reply[0]!.body), /The answer is 42\./);
        assert.equal(before.entries.filter(({ path: target }) => target === "loop://child/1").length, 0, "a reply does not imply completion");

        const result = outcome === "success"
            ? { status: 200 }
            : Results.failure("test:child", outcome, outcome === "cancel" ? 499 : 502, "The child could not finish.");
        const exact = await f.lifecycle.finish(f.childLoop, result, { terminatedBy: outcome === "cancel" ? "cancel" : null });
        assert.ok(exact);
        assert.equal(exact.content, undefined, "lifecycle outcomes do not copy a prior reply");
        const after = await f.run(f.parent, f.parentLoop);
        const observations = after.entries.filter(({ source }) => source === "worker://child");
        assert.deepEqual(observations.map(({ logPath: path }) => String(path).split("/").at(-1)), ["SEND", "READ"]);
        const completion = observations[1]!;
        assert.equal(completion.path, "loop://child/1");
        assert.equal(completion.origin, "_plurnk");
        assert.equal(completion.answers, undefined, "observation is not another answer");
        if (outcome === "success") {
            assert.equal(completion.body ?? "", "", "success needs no synthetic deliverable");
        } else {
            assert.equal(completion.status, exact.status);
            assert.match(JSON.stringify(completion), /The child could not finish\./);
            assert.ok(String(completion.body).length > 0, "failure stays visible even after an answer was delivered");
            if (outcome === "cancel") assert.match(String(completion.body), /worker cancelled/);
        }
        const history = await f.db.message_history.all<{ direction: string; body: string }>({ workspace_id: f.workspaceId, worker_id: f.child, loop_id: f.childLoop });
        assert.deepEqual(history.filter(({ direction }) => direction === "outbound").map(({ body }) => body), ["The answer is 42."]);
    });
}

test("{§env-delta-child-termination}: delayed observation preserves each completed loop after newer work starts", async (t) => {
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
    const completions = observed.entries.filter(({ path: target }) => String(target).startsWith("loop://child/"));
    assert.equal(completions.length, 2);
    assert.ok(completions.every(({ logPath: path }) => String(path).endsWith("/READ")));
    assert.deepEqual(completions.map(({ path: target }) => target), ["loop://child/1", "loop://child/2"]);
    assert.match(String(completions[0]!.body), /First result line 16/);
    assert.doesNotMatch(String(completions[0]!.body), /First result line 17/, "automatic observation obeys the ordinary READ preview");
    assert.match(String(completions[1]!.body), /Second loop failed\./);
    assert.equal(completions[1]!.status, 502);
    assert.equal((await f.db.engine_worker_has_undelivered_child_term.get({ worker_id: f.parent })), undefined);

    const curated = await f.run(f.parent, f.parentLoop,
        frame(`READ (${completions[0]!.path}) <1,-1>`) + "\n\n"
        + frame(`KILL (${completions[0]!.logPath}) <2,-1>`));
    const rows = await f.db.test_log_entries_by_loop.all<{ turn_id: number; op: string; status_rx: number; rx: string }>({ loop_id: f.parentLoop });
    const actions = rows.filter(({ turn_id }) => turn_id === curated.result.turnId);
    assert.deepEqual(actions.map(({ op, status_rx }) => [op, status_rx]), [["READ", 200], ["KILL", 200]]);
    assert.equal(JSON.parse(actions[0]!.rx).content, first, "source READ recovers the exact original result, never the current worker loop");
    assert.equal((await f.lifecycle.result(f.childLoop))?.content, first, "curation never changes the producer's result");
    assert.deepEqual((await f.lifecycle.result(secondLoop))?.problem, failure.problem);
    const again = await f.run(f.parent, f.parentLoop);
    assert.equal(again.entries.filter(({ source, path }) => source === "worker://child" && String(path).startsWith("loop://child/")).length, 2, "observing again creates no duplicate occurrences");
});
