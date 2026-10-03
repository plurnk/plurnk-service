// {§worker-optimistic-settlement} — an execution receives one turn-scoped opportunity
// to settle before the terminal SEND judges whether the stream needs monitoring.

import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import Engine from "../../src/core/Engine.ts";
import ChannelWrite from "../../src/core/ChannelWrite.ts";
import type { Executor } from "../../src/core/ExecutorRegistry.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import type Exec from "../../src/schemes/Exec.ts";
import { Results } from "@plurnk/plurnk-schemes";
import { concludeStmt, execStmt, dispositionStmt, sendStmt, killStmt, urlPath } from "./_dsl.ts";
import { DEFAULT_MIMETYPES } from "./_scheme.ts";
import { insertLoop, insertWorker, insertWorkspace, openMigrated } from "./_db.ts";
import { testExecutors } from "./_execs.ts";

let runtimeSequence = 0;

const response = (tag: string, disposition: "WAIT" | "SEND") => ({
    assistant: {
        content: "",
        reasoning: null,
        ops: [execStmt(tag, "go"), disposition === "WAIT" ? dispositionStmt("WAIT") : sendStmt(null, "The execution failed.")],
    },
});

const wire = async (run: Executor["run"]) => {
    const db = await openMigrated();
    const schemes = new SchemeRegistry();
    const engine = new Engine({ db, schemes, mimetypes: DEFAULT_MIMETYPES });
    const executors = await testExecutors();
    engine.setExecutors(executors);
    schemes.registerRuntimeSchemes(executors);
    const tag = `settle${++runtimeSequence}`;
    engine.registerRuntime(tag, {
        executor: {
            runtime: tag,
            glyph: "~",
            get manifest() {
                return {
                    name: tag,
                    channels: { results: "text/stream" },
                    defaultChannel: "results",
                    category: "data",
                    writableBy: ["plugin"],
                    volatile: true,
                    modelVisible: true,
                } as never;
            },
            get defaultChannel() { return "results"; },
            get channels() { return { results: { mimetype: "text/stream", defaultState: "active" as const } }; },
            effect: () => "pure" as const,
            probe: async () => ({ available: true as const, detail: undefined }),
            run,
        },
        namespaceOwner: { kind: "module", name: `${tag} fixture` },
        glyph: "~",
        summary: "Settlement fixture.",
        invocation: { body: { role: "fixture input", required: true }, example: { body: "fixture" } },
        details: "",
        available: true,
        detail: undefined,
    } as never);
    const workspaceId = await insertWorkspace(db, `settlement-${crypto.randomUUID()}`);
    const workerId = await insertWorker(db, workspaceId);
    const loopId = await insertLoop(db, workerId, 1, "settle the stream");
    return { db, engine, schemes, tag, workspaceId, workerId, loopId };
};

const idle = async (schemes: SchemeRegistry): Promise<void> => {
    await (schemes.get("exec") as Exec).idle();
};

test("{§subscriptions-subscription-registry-routes-cancellation} a failed executor close retains a callable owner for its durable obligation", { timeout: 10000 }, async (t) => {
    const completion = Promise.withResolvers<{ status: number }>();
    const fixture = await wire(() => completion.promise);
    const failure = new Error("fixture durable closure failure");
    const close = t.mock.method(ChannelWrite, "closeSubscription", async () => { throw failure; }, { times: 1 });
    try {
        const result = await fixture.engine.runTurn({
            provider: new Mock({ contextWindow: 100000, responses: [response(fixture.tag, "WAIT")] }),
            workspaceId: fixture.workspaceId, workerId: fixture.workerId, loopId: fixture.loopId, messages: [],
        });
        assert.equal(result.status, 202);
        const settling = idle(fixture.schemes);
        completion.resolve({ status: 200 });
        await settling;
        assert.equal(close.mock.callCount(), 1);
        const open = await fixture.db.find_open_subscriptions_for_worker.all<{ id: number }>({ worker_id: fixture.workerId });
        assert.equal(open.length, 1, "failed persistence cannot pretend the obligation has settled");
        const subscription = await fixture.db.test_get_subscription.get<{ entry_id: number }>({ id: open[0].id });
        const entry = await fixture.db.test_get_entry_by_id.get<{ pathname: string }>({ id: subscription!.entry_id });
        const logs = await fixture.db.test_log_entries_by_turn.all<{ sequence: number }>({ turn_id: result.turnId });
        const killed = await fixture.engine.dispatch({
            statement: killStmt(urlPath(fixture.tag, entry!.pathname)),
            workspaceId: fixture.workspaceId, workerId: fixture.workerId, loopId: fixture.loopId,
            turnId: result.turnId, sequence: Math.max(...logs.map(({ sequence }) => sequence)) + 1, origin: "model",
        });
        assert.equal(killed.status, 200, "KILL can settle the durable obligation through its retained owner");
        assert.equal((await fixture.db.find_open_subscriptions_for_worker.all({ worker_id: fixture.workerId })).length, 0);
        const closed = await fixture.db.test_get_subscription.get<{ close_status: number }>({ id: open[0].id });
        assert.equal(closed?.close_status, 200, "settlement retains the producer's actual result, not a fabricated cancellation");
    } finally {
        completion.resolve({ status: 200 });
        await idle(fixture.schemes);
        await fixture.db.close();
    }
});

test("{§send-wait-scope} a decorated WAIT parks on its actual live stream; the decoration is a label, never a join", async () => {
    const previous = process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
    process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "1";
    const completion = Promise.withResolvers<{ status: number }>();
    const fixture = await wire(() => completion.promise);
    try {
        const content = [
            PlurnkParser.frame(fixture.tag, "go"),
            PlurnkParser.frame("WAIT (worker://absent) <0,0> [{\"timeout\":0}]", "Await results."),
        ].join("\n\n");
        const result = await fixture.engine.runTurn({
            provider: new Mock({ contextWindow: 100000, responses: [{ assistant: { content, reasoning: null } }] }),
            workspaceId: fixture.workspaceId, workerId: fixture.workerId, loopId: fixture.loopId, messages: [],
        });
        assert.equal(result.status, 202);
        assert.deepEqual(result.outcomes, [
            { op: fixture.tag, status: 200, problemType: null },
            { op: "WAIT", status: 202, problemType: null },
        ]);
        const attempts = await fixture.db.test_turn_attempts.all<{ accepted: number; parse_errors: string }>({ turn_id: result.turnId });
        assert.deepEqual(attempts.map(({ accepted, parse_errors }) => [accepted, JSON.parse(parse_errors)]), [[1, []]]);
    } finally {
        completion.resolve({ status: 200 });
        await idle(fixture.schemes);
        await fixture.db.close();
        if (previous === undefined) delete process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
        else process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = previous;
    }
});

test("{§worker-lifecycle-subscription-matrix} fast current-turn streams settle before waiting and do not become monitored work", async () => {
    const previous = process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
    process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "1000";
    let startedAt = 0;
    const fixture = await wire(async () => {
        startedAt = Date.now();
        await new Promise((resolve) => setTimeout(resolve, 25));
        return { status: 200 };
    });
    try {
        const result = await fixture.engine.runTurn({
            provider: new Mock({ contextWindow: 100000, responses: [response(fixture.tag, "WAIT")] }),
            workspaceId: fixture.workspaceId,
            workerId: fixture.workerId,
            loopId: fixture.loopId,
            messages: [],
        });
        assert.equal(result.status, 102, "a concluded-but-unobserved stream continues to its observation turn");
        assert.deepEqual(result.outcomes, [
            { op: fixture.tag, status: 200, problemType: null },
            { op: "WAIT", status: 102, problemType: null },
        ]);
        assert.ok(Date.now() - startedAt < 500, "settlement ends when the stream settles, not at the full cap");
    } finally {
        await idle(fixture.schemes);
        await fixture.db.close();
        if (previous === undefined) delete process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
        else process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = previous;
    }
});

test("{§worker-lifecycle-subscription-matrix} a current-turn stream still active at the settlement cap follows the ordinary monitored path", async () => {
    const previous = process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
    process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "40";
    let release!: () => void;
    let startedAt = 0;
    const fixture = await wire(() => new Promise((resolve) => {
        startedAt = Date.now();
        release = () => resolve({ status: 200 });
    }));
    try {
        const result = await fixture.engine.runTurn({
            provider: new Mock({ contextWindow: 100000, responses: [response(fixture.tag, "WAIT")] }),
            workspaceId: fixture.workspaceId,
            workerId: fixture.workerId,
            loopId: fixture.loopId,
            messages: [],
        });
        assert.equal(result.status, 202, "the still-live stream remains a genuine monitored obligation");
        assert.deepEqual(result.outcomes, [
            { op: fixture.tag, status: 200, problemType: null },
            { op: "WAIT", status: 202, problemType: null },
        ]);
        assert.ok(Date.now() - startedAt >= 30, "SEND adjudication follows the configured settlement opportunity");
        release();
    } finally {
        release?.();
        await idle(fixture.schemes);
        await fixture.db.close();
        if (previous === undefined) delete process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
        else process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = previous;
    }
});

// {§send-premature-terminate}: a fast failure must settle before strike exhaustion reaps work.
test("a fast failed stream settles naturally and its observed failure does not itself strike out the loop", async () => {
    const previous = process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
    process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = "1000";
    const fixture = await wire(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return Results.failure("executor:settle", "nonzero-exit", 500, "The fast stream failed.");
    });
    try {
        const result = await fixture.engine.runLoop({
            provider: new Mock({ contextWindow: 100000, responses: [response(fixture.tag, "SEND"), {
                assistant: { content: "", reasoning: null, ops: [concludeStmt("")] },
            }] }),
            workspaceId: fixture.workspaceId,
            workerId: fixture.workerId,
            loopId: fixture.loopId,
            maxStrikes: 1,
            messages: [],
        });
        assert.equal(result.result.status, 200, "a handled executor failure does not manufacture a loop failure");
        assert.equal(result.turnIds.length, 3, "initialization, execution, and observation");
        await idle(fixture.schemes);
        const subscription = await fixture.db.test_latest_subscription_for_worker.get<{ close_status: number | null }>({
            worker_id: fixture.workerId,
        });
        assert.equal(subscription?.close_status, 500, "the stream retains its own failure, never a cancellation");
    } finally {
        await idle(fixture.schemes);
        await fixture.db.close();
        if (previous === undefined) delete process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS;
        else process.env.PLURNK_SERVICE_OPTIMISTIC_WAIT_MS = previous;
    }
});
