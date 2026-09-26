import test from "node:test";
import { strict as assert } from "node:assert";
import InferenceAdmission from "./InferenceAdmission.ts";

const admission = (limit = 1) => InferenceAdmission.forEndpoint(`fixture:${crypto.randomUUID()}`, limit);

test("{§provider-inference-admission} FIFO reserves capacity synchronously, including handoff to a waiter", async () => {
    const gate = admission();
    const first = await gate.acquire();
    const order: number[] = [];
    const second = gate.acquire().then((release) => { order.push(2); return release; });
    const third = gate.acquire().then((release) => { order.push(3); return release; });
    await Promise.resolve();
    assert.equal(order.length, 0);
    first();
    const fourth = gate.acquire().then((release) => { order.push(4); return release; });
    const releaseSecond = await second;
    assert.deepEqual(order, [2]);
    releaseSecond();
    const releaseThird = await third;
    assert.deepEqual(order, [2, 3]);
    releaseThird();
    (await fourth)();
    assert.deepEqual(order, [2, 3, 4]);
});

test("{§provider-inference-admission} cancelled and already-aborted waiters consume no capacity", async () => {
    const gate = admission();
    const release = await gate.acquire();
    const cancellation = new AbortController();
    const reason = new Error("cancelled child");
    const cancelled = gate.acquire(cancellation.signal);
    const rejection = assert.rejects(cancelled, (error) => error === reason);
    const next = gate.acquire();
    cancellation.abort(reason);
    await rejection;
    assert.throws(() => gate.acquire(cancellation.signal), (error) => error === reason);
    release();
    (await next)();
    (await gate.acquire())();
});

test("{§provider-inference-admission} release cannot mint extra capacity", async () => {
    const gate = admission();
    const release = await gate.acquire();
    release();
    assert.throws(release, /lease was released twice/);
    (await gate.acquire())();
});

test("{§provider-inference-admission} equivalent endpoint URLs resolve one capacity owner", () => {
    const host = `${crypto.randomUUID()}.test`;
    assert.equal(
        InferenceAdmission.forEndpoint(`HTTP://${host.toUpperCase()}:80/v1/`, 1),
        InferenceAdmission.forEndpoint(`http://${host}/v1`, 1),
    );
});
