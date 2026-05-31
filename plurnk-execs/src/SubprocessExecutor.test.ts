import test from "node:test";
import { strict as assert } from "node:assert";
import SubprocessExecutor from "./SubprocessExecutor.ts";
import type { ExecArgs, ExecResult } from "./types.ts";
import type { TelemetryEvent } from "./TelemetryEvent.ts";

// Drive a real subprocess and collect the sink activity. Resolves once run()
// settles.
const exec = async (runtime: string, command: string, opts: { signal?: AbortSignal } = {}) => {
    const out: Record<string, string> = { stdout: "", stderr: "" };
    const states: { channel: string; state: string }[] = [];
    const events: TelemetryEvent[] = [];
    const args: ExecArgs = {
        runtime, command, cwd: null,
        signal: opts.signal ?? new AbortController().signal,
        write: (channel, chunk) => { out[channel] = (out[channel] ?? "") + chunk; },
        setState: (channel, state) => states.push({ channel, state }),
        emit: (event) => events.push(event),
    };
    const result: ExecResult = await new SubprocessExecutor({ runtime, glyph: "🐚" }).run(args);
    return { result, out, states, events };
};

test("SubprocessExecutor declares stdout + stderr channels", () => {
    const ex = new SubprocessExecutor({ runtime: "sh", glyph: "🐚" });
    assert.deepEqual(ex.channels, {
        stdout: { mimetype: "text/stream" },
        stderr: { mimetype: "text/stream" },
    });
});

test("sh: stdout streamed, channels closed, exit 0", async () => {
    const { result, out, states, events } = await exec("sh", "echo hello");
    assert.deepEqual(result, { status: 200, exitCode: 0 });
    assert.equal(out.stdout, "hello\n");
    assert.deepEqual(states, [
        { channel: "stdout", state: "closed" },
        { channel: "stderr", state: "closed" },
    ]);
    assert.equal(events.length, 0);
});

test("sh: nonzero exit → status 500, errored channels, no telemetry (program result, not framework failure)", async () => {
    const { result, states, events } = await exec("sh", "echo oops 1>&2; exit 3");
    assert.equal(result.status, 500);
    assert.equal(result.exitCode, 3);
    assert.deepEqual(states, [
        { channel: "stdout", state: "errored" },
        { channel: "stderr", state: "errored" },
    ]);
    assert.equal(events.length, 0);
});

test("sh: stderr captured into the stderr channel", async () => {
    const { out } = await exec("sh", "echo to-err 1>&2");
    assert.equal(out.stderr, "to-err\n");
});

test("spawn failure on a nonexistent binary emits spawn_failed telemetry", async () => {
    const { result, states, events } = await exec("definitely-not-a-real-binary-xyz", "noop");
    assert.equal(result.status, 500);
    assert.equal(events.length, 1);
    assert.equal(events[0].source, "exec:definitely-not-a-real-binary-xyz");
    assert.equal(events[0].kind, "spawn_failed");
    assert.equal(states.at(-1)?.state, "errored");
});

test("abort mid-run → status 499", async () => {
    const controller = new AbortController();
    const promise = exec("sh", "sleep 5", { signal: controller.signal });
    controller.abort();
    const { result, states } = await promise;
    assert.equal(result.status, 499);
    assert.equal(states.at(-1)?.state, "errored");
});
