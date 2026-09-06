import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Mock } from "@plurnk/plurnk-providers";
import { liveLoop, liveWorkspace } from "../_live-harness.ts";
import { connect, rpcCall, withDaemon, waitForDb } from "./_rpc.ts";
import Daemon from "../../src/server/Daemon.ts";
import ProviderInstantiate from "../../src/core/ProviderInstantiate.ts";
import Digest from "../../src/digest/Digest.ts";

test("{§live-harness-deadline}: an expired specimen finishes cleanup before the next specimen", async () => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    for (const fail of ["0", "1"]) {
        await assert.rejects(promisify(execFile)(process.execPath, [
            "--conditions=plurnk-dev", "--test", "--test-reporter=spec",
            fileURLToPath(new URL("./fixtures/live-deadline.fixture.ts", import.meta.url)),
        ], { timeout: 5000, env: { ...env, PLURNK_SERVICE_LIVE_TIMEOUT: "30", PLURNK_TEST_CLEANUP_FAIL: fail } }), (error: unknown) => {
            const result = error as { code?: number; stdout?: string; stderr?: string; killed?: boolean };
            assert.equal(result.code, 1, "only the deliberately expired specimen fails");
            assert.notEqual(result.killed, true, "the test process exits by itself");
            assert.match(result.stdout ?? "", /deadline cleanup completed[\s\S]*next specimen started after cleanup/);
            assert.match(result.stdout ?? "", /✔ next specimen sees completed cleanup/);
            if (fail === "1") assert.match((result.stdout ?? "") + (result.stderr ?? ""), /cleanup failed visibly/);
            return true;
        });
    }
});

test("{§live-harness-deadline}: failed workspace startup still stops, closes and digests its resources", async (t) => {
    const provider = new Mock({ contextWindow: 100_000, responses: [] });
    t.mock.method(ProviderInstantiate, "loadActiveProvider", async () => provider);
    const stopped = t.mock.method(Daemon.prototype, "stop");
    const digested = t.mock.method(Digest, "run");
    const failure = new Error("workspace startup failed");
    t.mock.method(Daemon.prototype, "start", async () => { throw failure; });
    await assert.rejects(liveWorkspace({ name: "harness-startup-failure" }), (error) => error === failure);
    assert.equal(stopped.mock.callCount(), 1);
    assert.equal(digested.mock.callCount(), 1, "the closed database remains a diagnostic artifact");
});

test("{§methods-loop-cancel}: the live harness preserves caller cancellation and stops inference", async (t) => {
    const provider = new Mock({ contextWindow: 100_000, responses: [] });
    const entered = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<unknown>();
    t.mock.method(provider, "generate", async ({ signal }: { signal: AbortSignal }) => {
        entered.resolve();
        return await new Promise((_, reject) => {
            signal.addEventListener("abort", () => {
                cancelled.resolve(signal.reason);
                reject(signal.reason);
            }, { once: true });
        });
    });
    await withDaemon(provider, async (db, _daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "live-harness-cancel" });
            const controller = new AbortController();
            const reason = new Error("outer specimen cancelled");
            const running = liveLoop({ db, ws }, 2, { prompt: "wait" }, { timeoutMs: 1000, signal: controller.signal });
            const rejected = assert.rejects(running, (error) => error === reason);
            await entered.promise;
            controller.abort(reason);
            await rejected;
            assert.ok(await cancelled.promise, "the provider receives cancellation before teardown");
            const rows = await waitForDb(
                () => db.test_list_loops_all.all<{ status: number; terminal_result: string }>({}),
                (loops) => loops.some((loop) => loop.status === 499),
            );
            const result = JSON.parse(rows.find((loop) => loop.status === 499)!.terminal_result);
            assert.match(result.problem.reason, /outer specimen cancelled/);
            assert.doesNotMatch(result.problem.reason, /harness_timeout/);
        } finally { ws.close(); }
    });
});

test("{§methods-loop-cancel}: an admission failure is not misreported as a harness timeout", async (t) => {
    const provider = new Mock({ contextWindow: 100_000, responses: [] });
    await withDaemon(provider, async (db, daemon, addr) => {
        const ws = await connect(addr);
        try {
            await rpcCall(ws, 1, "workspace.create", { name: "live-harness-admission" });
            t.mock.method(daemon, "runLoop", async () => { throw new Error("admission failed"); });
            const cancellation = t.mock.method(daemon, "cancelDrain", () => false);
            await assert.rejects(liveLoop({ db, ws }, 2, { prompt: "go" }), /admission failed/);
            assert.equal(cancellation.mock.callCount(), 1);
            assert.match(String(cancellation.mock.calls[0].arguments[1]), /admission failed/);
            assert.doesNotMatch(String(cancellation.mock.calls[0].arguments[1]), /harness_timeout/);
        } finally { ws.close(); }
    });
});
