import WorkerName from "../../src/core/WorkerName.ts";
import { sendStmt, killStmt, noteStmt  } from "./_dsl.ts";
import test from "node:test";
import assert from "node:assert/strict";
import type { EditStatement, PlurnkStatement, UrlPath } from "@plurnk/plurnk-contracts";
import Engine from "../../src/core/Engine.ts";
import ChannelWrite from "../../src/core/ChannelWrite.ts";
import LoopLifecycle from "../../src/core/LoopLifecycle.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import Turn from "../../src/core/Turn.ts";
import TurnMaterialization from "../../src/core/TurnMaterialization.ts";
import { Mock } from "@plurnk/plurnk-providers";
import type { MockResponse } from "@plurnk/plurnk-providers";
import { openMigrated, insertWorkspace, insertWorker, insertLoop, seedEntryWithChannel } from "./_helpers.ts";

const urlPath = (scheme: string, pathname: string): UrlPath => ({
    kind: "url", raw: `${scheme}://${pathname}`, scheme,
    username: null, password: null, hostname: null, port: null,
    pathname, query: null, fragment: null,
});

const editStmt = (pathname: string, body: string): EditStatement => ({
    metadata: null,
    op: "EDIT", aside: null,
    target: urlPath("worker", pathname),
    lineMarker: null, body, matcher: null, position: { line: 1, column: 1 },
});

const response = (ops: PlurnkStatement[]): MockResponse => ({
    assistant: { content: "", ops, reasoning: null },
});

const contentResponse = (content: string): MockResponse => ({
    assistant: { content, reasoning: null },
});

const setup = async () => {
    const db = await openMigrated();
    const workspaceId = await insertWorkspace(db, `ws-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1, "test prompt");
    const lifecycle = new LoopLifecycle(db);
    const engine = new Engine({ db, schemes: new SchemeRegistry(), cancelWorker: async (id, reason) => { await lifecycle.cancelTree(id, reason, true); } });
    return { db, engine, workspaceId, workerId, loopId };
};

for (const kind of ["child", "stream"] as const) for (const phase of ["before observation", "after observation", "during inference"] as const) {
test(`{§loop-wake-identity}: ${kind} completion ${phase} is acknowledged only by the input that contains it`, async (t) => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        const lifecycle = new LoopLifecycle(db);
        const parkedLoop = await insertLoop(db, workerId, 2, "An independent waiting task.");
        await lifecycle.park(parkedLoop);
        let finish: () => Promise<unknown>;
        if (kind === "child") {
            const child = await insertWorker(db, workspaceId, workerId, "child");
            const childLoop = await insertLoop(db, child, 1, "Look up the answer.");
            finish = () => lifecycle.finish(childLoop, { status: 200, content: "The observed answer is 42." });
        } else {
            const entry = await seedEntryWithChannel(db, { workspaceId, scheme: "sh", content: "The observed answer is 42.", state: "active" });
            const subscriptionId = await ChannelWrite.openSubscription(db, { workerId, entryId: entry, scheme: "exec", handle: "answer" });
            finish = () => ChannelWrite.closeSubscription(db, { subscriptionId, result: { status: 200 } });
        }
        let settled = false;
        const settle = async () => {
            if (!settled) {
                settled = true;
                await finish();
            }
        };
        if (phase === "before observation") {
            const open = Turn.open;
            t.mock.method(Turn, "open", async (...args: Parameters<typeof open>) => {
                const turn = await open(...args);
                if (args[1].loopId === loopId && args[1].producer === "model") await settle();
                return turn;
            });
        } else if (phase === "after observation") {
            const method = kind === "child" ? "materializeEnvironmentDeltas" : "materializeStreamDeltas";
            const materialize = TurnMaterialization.prototype[method];
            t.mock.method(TurnMaterialization.prototype, method, async function (this: TurnMaterialization, ...args: Parameters<typeof materialize>) {
                const rows = await materialize.apply(this, args);
                if (args[0].loopId === loopId) await settle();
                return rows;
            });
        }
        const provider = new Mock({ contextWindow: 100_000, responses: [
            contentResponse("````SEND\nThe answer is 42.\n````"),
            contentResponse("````NOTE\nThe answer was already delivered.\n````"),
        ] });
        if (phase === "during inference") {
            const generate = provider.generate.bind(provider);
            t.mock.method(provider, "generate", async (...args: Parameters<typeof generate>) => {
                await settle();
                return generate(...args);
            });
        }
        const result = await engine.runLoop({ provider, workspaceId, workerId, loopId, messages: [] });
        const observed = phase === "before observation";
        assert.equal(JSON.stringify(provider.received[0]).includes("The observed answer is 42."), observed);
        assert.match(JSON.stringify(provider.received.at(-1)), /The observed answer is 42\./, "the terminal evidence reaches the producer before completion");
        assert.equal(result.result.status, 200);
        assert.equal(provider.received.length, observed ? 1 : 2, "exactly one additional inference is required for unseen evidence");
        assert.equal(await new LoopLifecycle(db).wake(parkedLoop, { eventOnly: true }), true, "this loop's acknowledgement cannot consume another loop's wake");
    } finally { await db.close(); }
});
}

test("Engine.runLoop: three edits are observed before answered work concludes", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        const provider = new Mock({
            contextWindow: 100000,
            responses: [
                response([editStmt("/a", "1"), noteStmt("continuing")]),
                response([editStmt("/b", "2"), noteStmt("still going")]),
                response([editStmt("/c", "3"), sendStmt(null, "done")]),
                // {§send-premature-terminate} — the third edit needs observation before conclusion.
                response([sendStmt(null, "done")]),
            ],
        });
        const result = await engine.runLoop({
            provider, workspaceId, workerId, loopId,
            messages: [{ role: "user", content: "do three steps" }],
        });
        assert.equal(result.turnIds.length, 5, "packetless initialization precedes three edit turns and the observation turn");
        assert.equal(result.result.status, 200);
        assert.equal(result.hitMaxTurns, false);

        for (const [pathname, content] of [["/a", "1"], ["/b", "2"], ["/c", "3"]]) {
            const entry = await db.test_get_channel_by_pathname_scheme.get({ scheme: "worker", pathname, name: "body" });
            assert.equal(entry?.content, content);
        }

        const loopStatus = (await db.test_get_loop_status.get<{ status: number }>({ id: loopId }))?.status;
        assert.equal(loopStatus, 200);
    } finally { await db.close(); }
});

test("Engine.runLoop: maxTurns hit — force-terminate with 429 and hitMaxTurns flag", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        const provider = new Mock({
            contextWindow: 100000,
            // Distinct EDIT paths avoid a cycle refusal while testing the turn ceiling.
            responses: Array.from({ length: 10 }, (_, i) => response([editStmt(`/t${i}`, "x"), noteStmt("more")])),
        });
        const result = await engine.runLoop({
            provider, workspaceId, workerId, loopId, maxTurns: 3,
            messages: [{ role: "user", content: "never terminate" }],
        });
        assert.equal(result.turnIds.length, 4, "packetless initialization does not consume the three-model-turn ceiling");
        assert.equal(result.result.status, 429, "max_turns → 429 Too Many Requests");
        assert.equal(result.hitMaxTurns, true);
        const loopStatus = (await db.test_get_loop_status.get<{ status: number }>({ id: loopId }))?.status;
        assert.equal(loopStatus, 429);
    } finally { await db.close(); }
});

test("maxTurns=-1 disables the turn terminator — loop ends on completed inventory, not a cap", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        // Four continuing turns then completion. A positive cap of 3 would
        // stop at turn 3; -1 must permit the final completed inventory.
        const provider = new Mock({
            contextWindow: 100000,
            responses: [
                response([editStmt("/1", "x"), noteStmt("1")]),
                response([editStmt("/2", "x"), noteStmt("2")]),
                response([editStmt("/3", "x"), noteStmt("3")]),
                response([editStmt("/4", "x"), noteStmt("4")]),
                response([sendStmt(null, "done")]),
            ],
        });
        const result = await engine.runLoop({
            provider, workspaceId, workerId, loopId, maxTurns: -1,
            messages: [{ role: "user", content: "run until I say done" }],
        });
        assert.equal(result.turnIds.length, 6, "initialization plus all five model turns — no turn cap");
        assert.equal(result.result.status, 200);
        assert.equal(result.hitMaxTurns, false);
    } finally { await db.close(); }
});

test("Engine.runLoop: repeated identical NOTE-only turns remain subject to the cycle rail", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        // {§engine-cycle-evidence}
        const provider = new Mock({
            contextWindow: 100000,
            responses: Array.from({ length: 5 }, () => contentResponse(
                "\n````NOTE\nidling\n````",
            )),
        });
        const result = await engine.runLoop({ provider, workspaceId, workerId, loopId, maxTurns: 10, maxStrikes: 2, messages: [] });
        assert.equal(result.result.status, 508, "identical inventory repetition is a cycle, not an idle-operation violation");
        assert.equal(result.result.problem?.type, "https://problems.plurnk.xyz/engine/rails/strike-threshold");
        assert.equal(result.reason, "strike_threshold");
        const errors = await db.test_error_rows_for_worker.all<{ rx: string }>({ worker_id: workerId });
        assert.deepEqual(errors, [], "the cycle rail does not invent an idle-operation error");
    } finally { await db.close(); }
});

test("{§completion-joins-live-work} Engine.runLoop: a completion over a live stream joins it — the loop parks, never a false 200", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        // Seed a live stream the worker holds: an open subscription (closed_at NULL) against a real entry.
        const entryId = await seedEntryWithChannel(db, { workspaceId, authority: await WorkerName.forId(db, workerId), pathname: "/live-stream" });
        await db.open_subscription.get<{ id: number }>({ worker_id: workerId, entry_id: entryId, scheme: "exec", handle: "live-1" });
        const provider = new Mock({ contextWindow: 100000, responses: [
            response([sendStmt(null, "all done")]),   // turn 1: a live stream makes this a join → 202 park
            response([noteStmt("Observe the settled stream.")]),
        ] });
        const result = await engine.runLoop({ provider, workspaceId, workerId, loopId, messages: [] });
        assert.equal(result.turnIds.length, 2, "initialization plus the one model turn: the join parked the loop on its first claim");
        assert.equal(result.result.status, 202, "the loop parked on the live stream, never a false 200");
        assert.equal(provider.remaining, 1, "no further turn runs until the stream concludes and wakes the loop");
        const rows = await db.test_log_entries_by_loop.all<{ op: string; origin: string; status_rx: number; rx: string }>({ loop_id: loopId });
        const modelRows = rows.filter((r) => r.origin === "model");
        assert.deepEqual(modelRows.map(({ op, status_rx }) => [op, status_rx]), [["SEND", 200]],
            "the reply is delivered; implicit joining invents no operation or receipt");
    } finally { await db.close(); }
});

test("Engine.runLoop: terminates immediately if loop.status is already non-102", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        await new LoopLifecycle(db).finish(loopId, { status: 200 });
        const provider = new Mock({ contextWindow: 100000, responses: [response([sendStmt(null, "")])] });
        const result = await engine.runLoop({
            provider, workspaceId, workerId, loopId,
            messages: [],
        });
        assert.deepEqual(result.turnIds, []);
        assert.equal(result.result.status, 200);
        assert.equal(result.hitMaxTurns, false);
        assert.equal(provider.remaining, 1, "provider untouched");
    } finally { await db.close(); }
});

test("Engine.runLoop: a durable 202 park outranks a later abort observation", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        await db.test_set_loop_status.run({
            id: loopId,
            status: 202,
            terminal_result: null,
        });
        const controller = new AbortController();
        controller.abort("daemon_stopping");
        const provider = new Mock({ contextWindow: 100000, responses: [] });

        const result = await engine.runLoop({
            provider,
            workspaceId,
            workerId,
            loopId,
            messages: [],
            signal: controller.signal,
        });

        assert.equal(result.result.status, 202);
        assert.equal(result.reason, "external");
        assert.deepEqual(result.turnIds, []);
        assert.equal(
            (await db.test_get_loop_status.get<{ status: number }>({ id: loopId }))?.status,
            202,
            "shutdown cannot launder a committed park into cancellation",
        );
    } finally { await db.close(); }
});

test("Engine.runLoop: KILL of the current worker cancels its scope", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        const provider = new Mock({
            contextWindow: 100000,
            responses: [response([noteStmt("thinking")]), response([killStmt({
                ...urlPath("worker", ""), raw: `worker://${await WorkerName.forId(db, workerId)}`,
                hostname: await WorkerName.forId(db, workerId),
            })])],
        });
        const result = await engine.runLoop({
            provider, workspaceId, workerId, loopId,
            messages: [{ role: "user", content: "may abort" }],
        });
        assert.equal(result.turnIds.length, 3, "packetless initialization precedes both model turns");
        assert.equal(result.result.status, 499);
        assert.equal(result.hitMaxTurns, false);
    } finally { await db.close(); }
});

test("Engine.runLoop: cross-turn state — turn 2 sees what turn 1 wrote", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        const readStmt = (pathname: string) => ({
            metadata: null,
            op: "READ" as const, aside: null,
            target: urlPath("worker", pathname),
            lineMarker: null, matcher: null, body: null,
            position: { line: 1, column: 1 },
        });
        const provider = new Mock({
            contextWindow: 100000,
            responses: [
                response([editStmt("/state", "from turn 1"), noteStmt("stored")]),
                // READ continues; its result enters turn 3, where it can be observed.
                response([readStmt("/state"), noteStmt("reading")]),
                response([sendStmt(null, "retrieved")]),
            ],
        });
        const result = await engine.runLoop({
            provider, workspaceId, workerId, loopId,
            messages: [{ role: "user", content: "store then retrieve" }],
        });
        assert.equal(result.turnIds.length, 4, "packetless initialization precedes three model turns");
        const readLog = await db.test_read_log_entries_for_turn_by_op.get<{ status_rx: number }>({ turn_id: result.turnIds[2], op: "READ" });
        assert.equal(readLog?.status_rx, 200, "READ in turn 2 found the entry written in turn 1");
    } finally { await db.close(); }
});

test("Engine.runLoop: signal abort between turns throws AbortError", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        const controller = new AbortController();
        const provider = new Mock({
            contextWindow: 100000,
            responses: [response([noteStmt("1")]), response([noteStmt("2")]), response([sendStmt(null, "3")])],
        });
        controller.abort();
        await assert.rejects(
            () => engine.runLoop({ provider, workspaceId, workerId, loopId, messages: [], signal: controller.signal }),
            { name: "AbortError" },
        );
    } finally { await db.close(); }
});

test("Engine.runLoop: turn sequence numbers monotonic", async () => {
    const { db, engine, workspaceId, workerId, loopId } = await setup();
    try {
        const provider = new Mock({
            contextWindow: 100000,
            responses: [
                response([noteStmt("1")]),
                response([noteStmt("2")]),
                response([sendStmt(null, "3")]),
            ],
        });
        await engine.runLoop({ provider, workspaceId, workerId, loopId, messages: [] });
        const seqs = await db.test_list_turns_in_loop.all<{ sequence: number }>({ loop_id: loopId });
        assert.deepEqual(seqs.map((s) => s.sequence), [1, 2, 3, 4]);
    } finally { await db.close(); }
});

test("a strike-threshold abandonment names itself in its exact terminal Problem", async () => {
    const db = await openMigrated();
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    try {
        const workspaceId = await insertWorkspace(db, `ws-strike-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "strike out");
        // A bounded matcher failure is a hard 400 (an empty NOTE is valid); distinct paths keep
        // the failures out of cycle detection.
        const provider = new Mock({ contextWindow: 100000, responses: Array.from({ length: 5 }, (_, i) => contentResponse(
            `\`\`\`\`FIND (worker:///note-${i}) [{"pattern":"$fC"}]\`\`\`\`
\`\`\`\`NOTE
going
\`\`\`\``,
        )) });
        const result = await engine.runLoop({ provider, workspaceId, workerId, loopId, maxTurns: 10, maxStrikes: 2, messages: [] });
        assert.equal(result.result.status, 500, "struck out to the engine's 500");

        assert.equal(result.result.problem?.type, "https://problems.plurnk.xyz/engine/rails/strike-threshold");
        assert.equal(result.result.problem?.turns, 2);
        assert.equal(result.result.problem?.retryable, false);
        assert.equal(result.result.problem?.instance, `loop://${(await db.worker_name_by_id.get<{ name: string }>({ worker_id: workerId }))!.name}/1`);
    } finally { await db.close(); }
});

test("the full terminal enumeration names itself — max_turns included", async () => {
    const db = await openMigrated();
    const engine = new Engine({ db, schemes: new SchemeRegistry() });
    try {
        const workspaceId = await insertWorkspace(db, `ws-terminals-${crypto.randomUUID()}`);
        const workerId = await insertWorker(db, workspaceId);
        const loopId = await insertLoop(db, workerId, 1, "run to the ceiling");
        // A model that works forever (non-terminal SENDs) runs into the configured ceiling.
        const provider = new Mock({ contextWindow: 100000, responses: Array.from({ length: 4 }, () => response([noteStmt("working")])) });
        const result = await engine.runLoop({ provider, workspaceId, workerId, loopId, maxTurns: 2, maxStrikes: 99, messages: [] });
        assert.equal(result.result.status, 429);
        assert.equal(result.result.problem?.type, "https://problems.plurnk.xyz/engine/rails/max-turns");
        assert.match(result.result.problem?.detail ?? "", /turn ceiling/i);
        assert.equal(result.result.problem?.instance, `loop://${(await db.worker_name_by_id.get<{ name: string }>({ worker_id: workerId }))!.name}/1`);
    } finally { await db.close(); }
});
