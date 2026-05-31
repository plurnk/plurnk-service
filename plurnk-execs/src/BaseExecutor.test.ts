import test from "node:test";
import { strict as assert } from "node:assert";
import BaseExecutor from "./BaseExecutor.ts";
import type { ChannelDecl, ExecArgs, ExecResult } from "./types.ts";
import type { TelemetryEvent } from "./TelemetryEvent.ts";

// Minimal concrete executor exercising the contract: declares a single
// `results` channel, echoes the command into it, and reports the matched tag.
class EchoExecutor extends BaseExecutor {
    get channels(): Readonly<Record<string, ChannelDecl>> {
        return { results: { mimetype: "application/json" } };
    }
    async run(args: ExecArgs): Promise<ExecResult> {
        args.write("results", JSON.stringify({ runtime: args.runtime, command: args.command }));
        args.setState("results", "closed");
        return { status: 200 };
    }
}

// Capture the sinks the scheme would provide.
const harness = () => {
    const writes: { channel: string; chunk: string }[] = [];
    const states: { channel: string; state: string }[] = [];
    const events: TelemetryEvent[] = [];
    const args = (overrides: Partial<ExecArgs> = {}): ExecArgs => ({
        runtime: "search",
        command: "pie recipes",
        cwd: null,
        signal: new AbortController().signal,
        write: (channel, chunk) => writes.push({ channel, chunk }),
        setState: (channel, state) => states.push({ channel, state }),
        emit: (event) => events.push(event),
        ...overrides,
    });
    return { writes, states, events, args };
};

test("BaseExecutor: constructor binds runtime tag and glyph", () => {
    const ex = new EchoExecutor({ runtime: "news", glyph: "📰" });
    assert.equal(ex.runtime, "news");
    assert.equal(ex.glyph, "📰");
});

test("BaseExecutor: declares its own channel topology", () => {
    const ex = new EchoExecutor({ runtime: "search", glyph: "🔎" });
    assert.deepEqual(ex.channels, { results: { mimetype: "application/json" } });
});

test("BaseExecutor.run: writes to declared channel and closes it", async () => {
    const ex = new EchoExecutor({ runtime: "search", glyph: "🔎" });
    const h = harness();
    const result = await ex.run(h.args({ runtime: "search", command: "pie recipes" }));

    assert.deepEqual(result, { status: 200 });
    assert.deepEqual(h.writes, [
        { channel: "results", chunk: JSON.stringify({ runtime: "search", command: "pie recipes" }) },
    ]);
    assert.deepEqual(h.states, [{ channel: "results", state: "closed" }]);
    assert.equal(h.events.length, 0);
});

test("BaseExecutor.run: matched tag flows through to the executor", async () => {
    const ex = new EchoExecutor({ runtime: "images", glyph: "🖼" });
    const h = harness();
    await ex.run(h.args({ runtime: "images", command: "golden retriever" }));

    assert.deepEqual(JSON.parse(h.writes[0].chunk), { runtime: "images", command: "golden retriever" });
});
