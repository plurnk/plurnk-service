// {§treesitter-runtime-gate}
import test from "node:test";
import assert from "node:assert/strict";
import { initRuntime, loadLanguage } from "./runtime.ts";

const deferred = <T>() => { let resolve!: (v: T) => void; let reject!: (e: unknown) => void; const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };

test("concurrent first callers share one runtime initialization", async () => {
    let inits = 0;
    const gate = deferred<void>();
    const ts = { Parser: { init: () => { inits++; return gate.promise; } }, Language: { load: async (p: string) => ({ p }) } };
    const a = initRuntime(ts); const b = initRuntime(ts);
    assert.equal(inits, 1, "the second caller joins the first init instead of creating a second runtime");
    gate.resolve();
    await Promise.all([a, b]);
    assert.equal(inits, 1);
});

test("grammar loads run one at a time, and a failed load does not block the next", async () => {
    const order: string[] = [];
    const first = deferred<unknown>();
    const ts = {
        Parser: { init: async () => {} },
        Language: {
            load: (p: string) => {
                order.push(`start:${p}`);
                if (p === "first.wasm") return first.promise;
                if (p === "bad.wasm") return Promise.reject(new Error("bad grammar"));
                return Promise.resolve({ p });
            },
        },
    };
    const a = loadLanguage(ts, "first.wasm");
    const bad = loadLanguage(ts, "bad.wasm");
    const c = loadLanguage(ts, "third.wasm");
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(order, ["start:first.wasm"], "the second load waits for the first to settle");
    first.resolve({ p: "first.wasm" });
    await a;
    await assert.rejects(bad, /bad grammar/);
    assert.deepEqual(await c, { p: "third.wasm" });
    assert.deepEqual(order, ["start:first.wasm", "start:bad.wasm", "start:third.wasm"]);
});
