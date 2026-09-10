import assert from "node:assert/strict";
import test from "node:test";
import ExecutionInput from "./ExecutionInput.ts";

test("{§exec-input}: one receiver, ordered deliveries, and retirement", async () => {
    const lifetime = new AbortController();
    const input = new ExecutionInput(lifetime.signal, 1_000);
    assert.equal(input.unavailable()?.status, 409);
    const first = Promise.withResolvers<void>();
    const seen: string[] = [];
    input.register(async ({ body }) => {
        seen.push(body);
        if (body === "first") await first.promise;
        return { status: 200, result: { received: body } };
    });
    assert.throws(() => input.register(async () => ({ status: 200 })), /already registered/);
    const a = input.deliver("first", null);
    const b = input.deliver("second", ["custom=exact"]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(seen, ["first"]);
    first.resolve();
    assert.equal((await a).status, 200);
    assert.equal((await b).status, 200);
    assert.deepEqual(seen, ["first", "second"]);
    input.close();
    assert.equal((await input.deliver("never", null)).status, 410);
});

test("{§exec-input}: bounded backpressure cancels input without replay", async () => {
    const input = new ExecutionInput(new AbortController().signal, 20);
    let receiverSignal: AbortSignal | undefined;
    let calls = 0;
    input.register(async ({ signal }) => {
        calls++;
        receiverSignal = signal;
        return new Promise(() => {});
    });
    const result = await input.deliver("unacknowledged", null);
    assert.equal(result.status, 504);
    assert.match(result.problem?.type ?? "", /input-timeout$/);
    assert.equal(result.problem?.retryable, false);
    assert.equal(receiverSignal?.aborted, true);
    assert.equal((await input.deliver("retry", null)).status, 410);
    assert.equal(calls, 1);
});

test("{§exec-input}: execution teardown interrupts delivery and refuses new input", async () => {
    const lifetime = new AbortController();
    const input = new ExecutionInput(lifetime.signal, 1_000);
    const started = Promise.withResolvers<void>();
    input.register(async () => { started.resolve(); return new Promise(() => {}); });
    const pending = input.deliver("x", null);
    await started.promise;
    lifetime.abort();
    assert.equal((await pending).status, 499);
    assert.equal((await input.deliver("y", null)).status, 410);
});

test("{§exec-input}: cancelling a queued delivery neither sends it nor retires the active delivery", async () => {
    const input = new ExecutionInput(new AbortController().signal, 1_000);
    const first = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const seen: string[] = [];
    input.register(async ({ body }) => {
        seen.push(body);
        started.resolve();
        if (body === "first") await first.promise;
        return { status: 200 };
    });
    const a = input.deliver("first", null);
    await started.promise;
    const cancelled = new AbortController();
    const b = input.deliver("never", null, cancelled.signal);
    cancelled.abort();
    assert.equal((await b).status, 499);
    const c = input.deliver("last", null);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(seen, ["first"]);
    first.resolve();
    assert.equal((await a).status, 200);
    assert.equal((await c).status, 200);
    assert.deepEqual(seen, ["first", "last"]);
});

test("{§exec-input}: receiver contract failures are surfaced, retire input, and cannot be retried", async (t) => {
    const errors = t.mock.method(console, "error", () => {});
    for (const receiver of [
        async () => { throw new Error("receiver broke"); },
        async () => ({ status: 202 }),
    ]) {
        const input = new ExecutionInput(new AbortController().signal, 1_000);
        input.register(receiver);
        const result = await input.deliver("unknown delivery", null);
        assert.equal(result.status, 500);
        assert.match(result.problem?.type ?? "", /input-receiver-failed$/);
        assert.match(result.problem?.detail ?? "", /delivery may be partial/);
        assert.equal((await input.deliver("never retried", null)).status, 410);
    }
    assert.equal(errors.mock.callCount(), 2, "internal violations retain their original error in diagnostics");
});
