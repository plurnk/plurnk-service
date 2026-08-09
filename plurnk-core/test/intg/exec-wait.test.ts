// {§exec-optimistic-settlement} — an EXEC receives one turn-scoped opportunity
// to settle before the terminal SEND judges whether the stream needs monitoring.

import test from "node:test";
import assert from "node:assert/strict";
import { Mock } from "@plurnk/plurnk-providers";
import Engine from "../../src/core/Engine.ts";
import type { Executor } from "../../src/core/ExecutorRegistry.ts";
import SchemeRegistry from "../../src/core/SchemeRegistry.ts";
import type Exec from "../../src/schemes/Exec.ts";
import { execStmt, sendStmt } from "./_dsl.ts";
import {
    DEFAULT_MIMETYPES,
    insertLoop,
    insertWorker,
    insertWorkspace,
    openMigrated,
    testExecutors,
} from "./_helpers.ts";

let runtimeSequence = 0;

const response = (tag: string, disposition: number) => ({
    assistant: {
        content: "",
        reasoning: null,
        ops: [execStmt(tag, "go"), sendStmt(disposition)],
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
        example: "",
        documentation: "",
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

test("fast current-turn streams settle before SEND[202] and do not become monitored work", async () => {
    const previous = process.env.PLURNK_SERVICE_EXEC_WAIT_MS;
    process.env.PLURNK_SERVICE_EXEC_WAIT_MS = "1000";
    let startedAt = 0;
    const fixture = await wire(async () => {
        startedAt = Date.now();
        await new Promise((resolve) => setTimeout(resolve, 25));
        return { status: 200 };
    });
    try {
        const result = await fixture.engine.runTurn({
            provider: new Mock({ contextWindow: 100000, responses: [response(fixture.tag, 202)] }),
            workspaceId: fixture.workspaceId,
            workerId: fixture.workerId,
            loopId: fixture.loopId,
            messages: [],
        });
        assert.equal(result.status, 102, "a concluded-but-unobserved stream continues to its observation turn");
        assert.deepEqual(result.statuses, [200, 102]);
        assert.ok(Date.now() - startedAt < 500, "settlement ends when the stream settles, not at the full cap");
    } finally {
        await idle(fixture.schemes);
        await fixture.db.close();
        if (previous === undefined) delete process.env.PLURNK_SERVICE_EXEC_WAIT_MS;
        else process.env.PLURNK_SERVICE_EXEC_WAIT_MS = previous;
    }
});

test("a current-turn stream still active at the settlement cap follows the ordinary monitored path", async () => {
    const previous = process.env.PLURNK_SERVICE_EXEC_WAIT_MS;
    process.env.PLURNK_SERVICE_EXEC_WAIT_MS = "40";
    let release!: () => void;
    let startedAt = 0;
    const fixture = await wire(() => new Promise((resolve) => {
        startedAt = Date.now();
        release = () => resolve({ status: 200 });
    }));
    try {
        const result = await fixture.engine.runTurn({
            provider: new Mock({ contextWindow: 100000, responses: [response(fixture.tag, 202)] }),
            workspaceId: fixture.workspaceId,
            workerId: fixture.workerId,
            loopId: fixture.loopId,
            messages: [],
        });
        assert.equal(result.status, 202, "the still-live stream remains a genuine monitored obligation");
        assert.deepEqual(result.statuses, [200, 202]);
        assert.ok(Date.now() - startedAt >= 30, "SEND adjudication follows the configured settlement opportunity");
        release();
    } finally {
        release?.();
        await idle(fixture.schemes);
        await fixture.db.close();
        if (previous === undefined) delete process.env.PLURNK_SERVICE_EXEC_WAIT_MS;
        else process.env.PLURNK_SERVICE_EXEC_WAIT_MS = previous;
    }
});

test("strike settlement cannot reap a fast current-turn stream before its optimistic opportunity", async () => {
    const previous = process.env.PLURNK_SERVICE_EXEC_WAIT_MS;
    process.env.PLURNK_SERVICE_EXEC_WAIT_MS = "1000";
    const fixture = await wire(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return { status: 200 };
    });
    try {
        const result = await fixture.engine.runLoop({
            provider: new Mock({ contextWindow: 100000, responses: [response(fixture.tag, 200)] }),
            workspaceId: fixture.workspaceId,
            workerId: fixture.workerId,
            loopId: fixture.loopId,
            maxStrikes: 1,
            messages: [],
        });
        assert.equal(result.result.status, 500, "the unseen result still makes SEND[200] dishonest and strikes");
        await idle(fixture.schemes);
        const subscription = await fixture.db.test_latest_subscription_for_worker.get<{ close_status: number | null }>({
            worker_id: fixture.workerId,
        });
        assert.equal(subscription?.close_status, 200, "the rail terminates only after the fast operation settled naturally");
    } finally {
        await idle(fixture.schemes);
        await fixture.db.close();
        if (previous === undefined) delete process.env.PLURNK_SERVICE_EXEC_WAIT_MS;
        else process.env.PLURNK_SERVICE_EXEC_WAIT_MS = previous;
    }
});
