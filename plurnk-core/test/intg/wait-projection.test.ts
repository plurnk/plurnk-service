import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import Engine from "../../src/core/Engine.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import LogBody from "../../src/core/LogBody.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import { holdChild, insertLoop, insertWorker, insertWorkspace, openMigrated } from "./_db.ts";
import LogEntryProjection from "../../src/core/LogEntryProjection.ts";

for (const [headers, seconds] of [
    [["WAIT"], 300],
    [["WAIT <600>"], 600],
    [["WAIT (worker://missing) <0.25>"], 0.25],
    [["WAIT <600>", "WAIT <120>"], 120],
    [["WAIT <600>", "WAIT"], 300],
    [["KILL"], 300],
] as const) {
    test(`{§worker-wait-timing} ${headers.join(" + ")} bounds the child-only park to ${seconds} seconds`, async (t) => {
        t.mock.method(Date, "now", () => 10_000);
        const db = await openMigrated();
        t.after(() => db.close());
        const workspaceId = await insertWorkspace(db, "bounded-child-wait");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const childLoopId = await holdChild(db, workspaceId, workerId);
        const result = await new Engine({ db, schemes: new SchemeRegistry() }).runTurn({
            provider: new Mock({ contextWindow: 100_000, responses: [{ assistant: {
                content: headers.map((header) => PlurnkParser.frame(header, null)).join("\n\n"), reasoning: null,
            } }] }),
            workspaceId, workerId, loopId, messages: [],
        });
        assert.equal(result.status, 202);
        const lifecycle = new LoopLifecycle(db);
        const [parked] = await lifecycle.parked(workerId);
        assert.equal(parked?.wait_poll_at, 10_000 + seconds * 1000);
        assert.equal(await lifecycle.wake(loopId, { revision: parked!.wait_revision, dueAt: parked!.wait_poll_at! }), true);
        assert.equal(await lifecycle.status(loopId), 100, "expiry queues the same loop");
        assert.equal(await lifecycle.status(childLoopId), 102, "expiry does not cancel or conclude the child");
        assert.equal(await lifecycle.result(loopId), null);
        assert.equal(await lifecycle.result(childLoopId), null);
    });
}

test("{§worker-wait-timing} an early wake retires the override; a later bare WAIT uses the configured default", async (t) => {
    let now = 10_000;
    t.mock.method(Date, "now", () => now);
    const db = await openMigrated();
    t.after(() => db.close());
    const workspaceId = await insertWorkspace(db, "one-park-override");
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1);
    await holdChild(db, workspaceId, workerId);
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    const lifecycle = new LoopLifecycle(db);
    const run = (header: string) => engine.runTurn({
        provider: new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: PlurnkParser.frame(header, null), reasoning: null } }] }),
        workspaceId, workerId, loopId, messages: [],
    });
    assert.equal((await run("WAIT <600>")).status, 202);
    const [first] = await lifecycle.parked(workerId);
    assert.equal(first?.wait_poll_at, 610_000);
    now += 1000;
    assert.equal(await lifecycle.wake(loopId), true);
    assert.deepEqual(await lifecycle.parked(workerId), []);
    assert.equal((await db.drain_claim_next_loop.get({ worker_id: workerId }))?.id, loopId);
    assert.equal((await run("WAIT")).status, 202);
    const [second] = await lifecycle.parked(workerId);
    assert.equal(second?.wait_poll_at, 311_000);
    assert.equal(second?.wait_revision, first!.wait_revision + 1);
    assert.equal(await lifecycle.wake(loopId, { revision: first!.wait_revision, dueAt: 610_000 }), false,
        "the previous timer cannot end the new park");
});

for (const header of ["WAIT", "WAIT (sh:///missing) <60,60> [{\"timeout\":42}]"]) {
    test(`{§park-202-only} {§wait-obligation-matrix} ${header} parks on the actual live child, not the decoration`, async (t) => {
        const db = await openMigrated();
        t.after(() => db.close());
        const workspaceId = await insertWorkspace(db, "wait-obligations");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "Await the child.");
        await holdChild(db, workspaceId, workerId);
        const source = [PlurnkParser.frame(header, "Await results."), PlurnkParser.frame("NOTE", "The child is checking.")].join("\n\n");
        const result = await new Engine({ db, schemes: new SchemeRegistry() }).runTurn({
            provider: new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: source, reasoning: null } }] }),
            workspaceId, workerId, loopId, messages: [],
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

test("{§park-202-only} {§wait-obligation-matrix} WAIT retains literal prose without inventing a response", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, "continuation-inventory");
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const body = "Report the findings.";
        const source = PlurnkParser.frame("WAIT", body);
        const result = await engine.runTurn({
            provider: new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: source, reasoning: null } }] }),
            workspaceId, workerId, loopId, messages: [],
        });
        assert.equal(result.status, 102, "absence of live work does not complete a waiting task");
        const terminal = await new LoopLifecycle(db).result(loopId);
        assert.equal(terminal, null, "no deliverable is manufactured from a wait");
        const rows = await db.test_log_entries_by_turn.all<{ op: string | null; attrs: string; tx: string; rx: string; status_rx: number }>({ turn_id: result.turnId });
        assert.deepEqual(rows.filter((row) => row.op !== null && row.op !== "prompt" && !LogEntryProjection.isEmission(row)).map(({ op }) => op), ["WAIT"]);
        const wait = rows.find(({ op }) => op === "WAIT")!;
        assert.equal(wait.status_rx, 102);
        assert.equal(JSON.parse(wait.rx).detail, "Nothing is in flight. Continuing."); // {§pinned-wording-core}
        assert.equal(JSON.parse(wait.tx).body, body);
        const projection = LogBody.resolve({ op: "WAIT", tx: JSON.parse(wait.tx), rx: JSON.parse(wait.rx) });
        assert.equal(projection.mimetype, "text/plain");
        assert.equal(projection.content, body);
    } finally { await db.close(); }
});

test("{§wait-obligation-matrix} every idle WAIT receives the same plain receipt, however often it repeats", async () => {
    const db = await openMigrated();
    try {
        const workspaceId = await insertWorkspace(db, `idle-wait-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1);
        const engine = new Engine({ db, schemes: new SchemeRegistry() });
        const source = PlurnkParser.frame("WAIT", "Awaiting the answer.");
        const detailOf = async () => {
            const result = await engine.runTurn({
                provider: new Mock({ contextWindow: 100_000, responses: [{ assistant: { content: source, reasoning: null } }] }),
                workspaceId, workerId, loopId, messages: [],
            });
            assert.equal(result.status, 102, "an idle WAIT never parks and never concludes");
            const rows = await db.test_log_entries_by_turn.all<{ op: string | null; rx: string }>({ turn_id: result.turnId });
            return JSON.parse(rows.find(({ op }) => op === "WAIT")!.rx).detail as string;
        };

        const details = [await detailOf(), await detailOf(), await detailOf()];
        assert.deepEqual(details, Array(3).fill("Nothing is in flight. Continuing."), "a repeated idle WAIT is never corrected"); // {§pinned-wording-core}
    } finally { await db.close(); }
});
