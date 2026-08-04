import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

const localEnvironment = (t) => {
    const names = [
        "PLURNK_MIMETYPES_EMBED_BASE_URL",
        "PLURNK_MIMETYPES_EMBED_MODEL",
        "PLURNK_MIMETYPES_EMBED_CONTEXT_WINDOW",
        "PLURNK_MIMETYPES_EMBED_WORKERS",
    ];
    const prior = new Map(names.map((name) => [name, process.env[name]]));
    delete process.env.PLURNK_MIMETYPES_EMBED_BASE_URL;
    delete process.env.PLURNK_MIMETYPES_EMBED_MODEL;
    delete process.env.PLURNK_MIMETYPES_EMBED_CONTEXT_WINDOW;
    process.env.PLURNK_MIMETYPES_EMBED_WORKERS = "2";
    t.after(() => {
        for (const [name, value] of prior) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    });
};

const embedCore = (releaseRuntime) => ({
    dimension: 2,
    contextWindow: 8,
    async loadRuntime() { return {}; },
    async embedText() { return new Uint8Array(new Float32Array([0, 0]).buffer); },
    releaseRuntime,
});

test("dispose attempts runtime and every worker teardown and preserves every failure", async (t) => {
    localEnvironment(t);
    const runtimeFailure = new Error("runtime release failed");
    const workers = [];
    class FailingTerminateWorker extends EventEmitter {
        constructor() {
            super();
            this.failure = new Error(`worker ${workers.length} termination failed`);
            workers.push(this);
            queueMicrotask(() => this.emit("message", { ready: true }));
        }

        ref() {}
        unref() {}

        postMessage(message) {
            queueMicrotask(() => this.emit(
                "message",
                message.kind === "count"
                    ? { count: 1 }
                    : { buffer: new Float32Array([0, 0]).buffer },
            ));
        }

        async terminate() {
            throw this.failure;
        }
    }
    t.mock.module("node:worker_threads", { exports: { Worker: FailingTerminateWorker } });
    t.mock.module("./embed-core.js", {
        exports: embedCore(async () => { throw runtimeFailure; }),
    });
    const { countTokens, dispose, embed } = await import("./index.js?dispose-failures");
    await embed("warm runtime");
    assert.equal(await countTokens("warm pool"), 1);

    const [first, second] = await Promise.allSettled([dispose(), dispose()]);
    assert.equal(first.status, "rejected");
    assert.equal(second.status, "rejected");
    assert.equal(first.reason, second.reason, "concurrent callers join one teardown attempt");
    assert.ok(first.reason instanceof AggregateError);
    assert.equal(first.reason.message, "embedder shutdown failed");
    assert.deepEqual(first.reason.errors, [runtimeFailure, ...workers.map((worker) => worker.failure)]);
});

test("a partially started worker pool terminates every constructed worker", async (t) => {
    localEnvironment(t);
    const startupFailure = new Error("worker startup failed");
    const workers = [];
    class StartupWorker extends EventEmitter {
        constructor() {
            super();
            this.index = workers.length;
            this.terminations = 0;
            workers.push(this);
            queueMicrotask(() => {
                if (this.index === 0) this.emit("error", startupFailure);
                else this.emit("message", { ready: true });
            });
        }

        ref() {}
        unref() {}
        postMessage() {}

        async terminate() {
            this.terminations += 1;
        }
    }
    t.mock.module("node:worker_threads", { exports: { Worker: StartupWorker } });
    t.mock.module("./embed-core.js", { exports: embedCore(async () => {}) });
    const { countTokens, dispose } = await import("./index.js?partial-pool");

    await assert.rejects(() => countTokens("start"), (error) => error === startupFailure);
    assert.equal(workers.length, 2);
    assert.deepEqual(
        workers.map((worker) => worker.terminations),
        [1, 1],
        "pool startup owns and terminates every worker it constructed",
    );
    await assert.doesNotReject(dispose, "the already-surfaced startup failure owns no remaining resource");
});

test("a worker constructor failure releases workers constructed earlier in the pool", async (t) => {
    localEnvironment(t);
    const constructorFailure = new Error("worker construction failed");
    const workers = [];
    class ConstructorFailureWorker extends EventEmitter {
        constructor() {
            super();
            if (workers.length === 1) throw constructorFailure;
            this.terminations = 0;
            workers.push(this);
        }

        async terminate() {
            this.terminations += 1;
        }
    }
    t.mock.module("node:worker_threads", { exports: { Worker: ConstructorFailureWorker } });
    t.mock.module("./embed-core.js", { exports: embedCore(async () => {}) });
    const { countTokens, dispose } = await import("./index.js?worker-constructor-failure");

    await assert.rejects(() => countTokens("start"), (error) => error === constructorFailure);
    assert.equal(workers.length, 1);
    assert.equal(workers[0].terminations, 1, "the partially constructed pool retains no worker");
    await assert.doesNotReject(dispose);
});
