import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

const localEnvironment = (t, workers = "2") => {
    const names = [
        "PLURNK_EMBEDDING_MODEL",
        "PLURNK_EMBEDDING_WORKERS",
    ];
    const prior = new Map(names.map((name) => [name, process.env[name]]));
    delete process.env.PLURNK_EMBEDDING_MODEL;
    process.env.PLURNK_EMBEDDING_WORKERS = workers;
    t.after(() => {
        for (const [name, value] of prior) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    });
};

async function settleWithin(promise, milliseconds = 250) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(
                    () => reject(new Error(`operation did not settle within ${milliseconds}ms`)),
                    milliseconds,
                );
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

const embedCore = (releaseRuntime) => ({
    dimension: 2,
    contextWindow: 8,
    async loadRuntime() { return {}; },
    async embedText() { return new Uint8Array(new Float32Array([0, 0]).buffer); },
    countTokensWith(_tokenizer, text) { return text.length; },
    releaseRuntime,
});

test("{§mimetype-embedding-terminality}: a pool worker releases its runtime before closing", async (t) => {
    const runtime = { session: "owned" };
    const released = [];
    const messages = [];
    const parentPort = new EventEmitter();
    let closed;
    const close = new Promise((resolve) => { closed = resolve; });
    parentPort.postMessage = (message) => { messages.push(message); };
    parentPort.close = () => { closed(); };
    t.mock.module("node:worker_threads", { exports: { parentPort } });
    t.mock.module("./embed-core.js", {
        exports: {
            ...embedCore(async (value) => { released.push(value); }),
            async loadRuntime() { return runtime; },
        },
    });

    await import("./embed-worker.js?cooperative-dispose");
    parentPort.emit("message", { kind: "dispose" });
    await settleWithin(close);

    assert.deepEqual(released, [runtime]);
    assert.deepEqual(messages, [
        { ready: true, dispose: true },
        { disposed: true },
    ]);
});

test("{§mimetype-embedding-terminality}: pool disposal cooperatively releases idle workers", async (t) => {
    localEnvironment(t, "1");
    const events = [];
    class ReleasingWorker extends EventEmitter {
        constructor() {
            super();
            queueMicrotask(() => this.emit("message", { ready: true, dispose: true }));
        }

        ref() {}
        unref() {}

        postMessage({ kind, text }) {
            if (kind === "dispose") {
                events.push("dispose");
                queueMicrotask(() => {
                    this.emit("message", { disposed: true });
                    this.emit("exit", 0);
                });
                return;
            }
            queueMicrotask(() => this.emit("message", { count: text.length }));
        }

        async terminate() {
            events.push("terminate");
        }
    }
    t.mock.module("node:worker_threads", { exports: { Worker: ReleasingWorker } });
    t.mock.module("./embed-core.js", { exports: embedCore(async () => {}) });
    const { countTokens, dispose } = await import("./local.js?cooperative-dispose");

    assert.equal(await countTokens("warm"), 4);
    await dispose();
    assert.deepEqual(events, ["dispose"]);
});

test("{§mimetype-embedding-terminality}: failed cooperative release is surfaced and force-terminated", async (t) => {
    localEnvironment(t, "1");
    const events = [];
    class ReleaseFailureWorker extends EventEmitter {
        constructor() {
            super();
            queueMicrotask(() => this.emit("message", { ready: true, dispose: true }));
        }

        ref() {}
        unref() {}

        postMessage({ kind, text }) {
            if (kind === "dispose") {
                events.push("dispose");
                queueMicrotask(() => {
                    this.emit("message", { disposed: false, error: "session close failed" });
                    this.emit("exit", 0);
                });
                return;
            }
            queueMicrotask(() => this.emit("message", { count: text.length }));
        }

        async terminate() {
            events.push("terminate");
        }
    }
    t.mock.module("node:worker_threads", { exports: { Worker: ReleaseFailureWorker } });
    t.mock.module("./embed-core.js", { exports: embedCore(async () => {}) });
    const { countTokens, dispose } = await import("./local.js?cooperative-dispose-failure");

    assert.equal(await countTokens("warm"), 4);
    await assert.rejects(dispose(), (error) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.message, "embedder shutdown failed");
        assert.deepEqual(
            error.errors.map((cause) => cause.message),
            ["embed worker runtime release failed: session close failed"],
        );
        return true;
    });
    assert.deepEqual(events, ["dispose", "terminate"]);
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
    const { countTokens, dispose, embedQuery } = await import("./local.js?dispose-failures");
    await embedQuery("warm runtime");
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
    const { countTokens, dispose } = await import("./local.js?partial-pool");

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
    const { countTokens, dispose } = await import("./local.js?worker-constructor-failure");

    await assert.rejects(() => countTokens("start"), (error) => error === constructorFailure);
    assert.equal(workers.length, 1);
    assert.equal(workers[0].terminations, 1, "the partially constructed pool retains no worker");
    await assert.doesNotReject(dispose);
});

test("{§mimetype-embedding-terminality}: cancellation and teardown settle work accepted during worker startup", async (t) => {
    localEnvironment(t);
    const workers = [];
    let allConstructed;
    const constructed = new Promise((resolve) => { allConstructed = resolve; });
    class StartingWorker extends EventEmitter {
        constructor() {
            super();
            this.terminations = 0;
            workers.push(this);
            if (workers.length === 2) allConstructed();
        }

        ref() {}
        unref() {}
        postMessage() {}

        async terminate() {
            this.terminations += 1;
        }
    }
    t.mock.module("node:worker_threads", { exports: { Worker: StartingWorker } });
    t.mock.module("./embed-core.js", { exports: embedCore(async () => {}) });
    const { countTokens, dispose } = await import("./local.js?worker-startup-cancellation");
    const controller = new AbortController();
    const blocked = countTokens("startup never completes", { signal: controller.signal });
    await constructed;
    const reason = new DOMException("planning cancelled", "AbortError");
    controller.abort(reason);

    await assert.rejects(settleWithin(blocked), (error) => error === reason);
    await settleWithin(dispose());
    assert.deepEqual(
        workers.map((worker) => worker.terminations),
        [1, 1],
        "teardown releases every partially started worker without waiting for readiness",
    );
});

test("{§mimetype-embedding-terminality}: an active worker exit rejects its job while queued work and replacement capacity survive", async (t) => {
    localEnvironment(t);
    const workers = [];
    let firstPosted;
    const posted = new Promise((resolve) => { firstPosted = resolve; });
    class ExitWorker extends EventEmitter {
        constructor() {
            super();
            this.index = workers.length;
            this.terminations = 0;
            workers.push(this);
            queueMicrotask(() => this.emit("message", { ready: true }));
        }

        ref() {}
        unref() {}

        postMessage({ text }) {
            if (this.index === 0) {
                firstPosted();
                setImmediate(() => this.emit("exit", 23));
                return;
            }
            queueMicrotask(() => this.emit("message", { count: text.length }));
        }

        async terminate() {
            this.terminations += 1;
        }
    }
    t.mock.module("node:worker_threads", { exports: { Worker: ExitWorker } });
    t.mock.module("./embed-core.js", { exports: embedCore(async () => {}) });
    const { countTokens, dispose } = await import("./local.js?active-worker-exit");
    try {
        const failed = countTokens("crash");
        await posted;
        const surviving = countTokens("healthy");
        const queued = countTokens("queued");
        const results = await settleWithin(Promise.allSettled([failed, surviving, queued]));

        assert.equal(results[0].status, "rejected");
        assert.match(String(results[0].reason), /embed worker exited unexpectedly.*23/);
        assert.deepEqual(results.slice(1), [
            { status: "fulfilled", value: 7 },
            { status: "fulfilled", value: 6 },
        ]);
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(workers.length, 3, "the exited worker is replaced to restore configured capacity");
    } finally {
        await dispose();
    }
});

test("{§mimetype-embedding-terminality}: aborting an active token count retires it before later work is scheduled", async (t) => {
    localEnvironment(t, "1");
    const workers = [];
    let firstPosted;
    const posted = new Promise((resolve) => { firstPosted = resolve; });
    class HungWorker extends EventEmitter {
        constructor() {
            super();
            this.index = workers.length;
            this.terminations = 0;
            workers.push(this);
            queueMicrotask(() => this.emit("message", { ready: true }));
        }

        ref() {}
        unref() {}

        postMessage({ kind, text }) {
            if (this.index === 0) {
                firstPosted();
                return;
            }
            queueMicrotask(() => this.emit(
                "message",
                kind === "count"
                    ? { count: text.length }
                    : { buffer: new Float32Array([text.length, 0]).buffer },
            ));
        }

        async terminate() {
            this.terminations += 1;
        }
    }
    t.mock.module("node:worker_threads", { exports: { Worker: HungWorker } });
    t.mock.module("./embed-core.js", { exports: embedCore(async () => {}) });
    const { countTokens, dispose } = await import("./local.js?active-worker-abort");
    try {
        const controller = new AbortController();
        const blocked = countTokens("never returns", { signal: controller.signal });
        await posted;
        const reason = new DOMException("planning cancelled", "AbortError");
        controller.abort(reason);

        await assert.rejects(settleWithin(blocked), (error) => error === reason);
        assert.equal(
            await settleWithin(countTokens("replacement")),
            11,
            "later work runs on replacement capacity instead of queueing behind the abandoned call",
        );
        assert.equal(workers.length, 2);
        assert.equal(workers[0].terminations, 1);
    } finally {
        await dispose();
    }
});

test("{§mimetype-embedding-terminality}: bounded non-response rejects and replaces the active worker", async (t) => {
    localEnvironment(t, "1");
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const workers = [];
    let firstPosted;
    const posted = new Promise((resolve) => { firstPosted = resolve; });
    class TimedOutWorker extends EventEmitter {
        constructor() {
            super();
            this.index = workers.length;
            workers.push(this);
            queueMicrotask(() => this.emit("message", { ready: true }));
        }

        ref() {}
        unref() {}

        postMessage({ text }) {
            if (this.index === 0) {
                firstPosted();
                return;
            }
            queueMicrotask(() => this.emit("message", { count: text.length }));
        }

        async terminate() {}
    }
    t.mock.module("node:worker_threads", { exports: { Worker: TimedOutWorker } });
    t.mock.module("./embed-core.js", { exports: embedCore(async () => {}) });
    const { countTokens, dispose, embedDocuments } = await import("./local.js?active-worker-timeout");
    try {
        const blocked = embedDocuments(["never returns"]);
        await posted;
        t.mock.timers.tick(300_000);
        const outcome = await Promise.race([
            blocked.then(
                (value) => ({ status: "fulfilled", value }),
                (reason) => ({ status: "rejected", reason }),
            ),
            new Promise((resolve) => setImmediate(() => resolve({ status: "pending" }))),
        ]);
        assert.equal(outcome.status, "rejected");
        assert.equal(outcome.reason.name, "TimeoutError");
        assert.match(outcome.reason.message, /exceeded 300000ms/);

        const replacement = await Promise.race([
            countTokens("replacement").then((value) => ({ status: "fulfilled", value })),
            new Promise((resolve) => setImmediate(() => resolve({ status: "pending" }))),
        ]);
        assert.deepEqual(replacement, { status: "fulfilled", value: 11 });
        assert.equal(workers.length, 2);
    } finally {
        await dispose();
    }
});
