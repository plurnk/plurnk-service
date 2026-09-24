import test from "node:test";
import assert from "node:assert/strict";
import DigestRender from "./DigestRender.ts";

// {§exec-env-scoped} — a spawn's row carries the environment it received; the waterfall names every
// value's provenance so a run's commands can never be misread as having run under the host's shell.
// {§provider-wire-emission} — an empty emission is read from what the wire carried.
test("{§provider-wire-emission} the digest reads a blank emission from the wire record", () => {
    const line = DigestRender.wireLine({
        content: "", reasoning: "Let me read it.",
        wire: {
            chunks: 8, emptyChunks: 4, fields: { reasoning_content: 1, tool_calls: 2, refusal: 1 }, channels: { refusal: "no" },
            toolCalls: [{ index: 0, id: "call-1", type: "function", name: "READ", arguments: "{\"path\": \"django/views/debug.py\"}" }],
            finishReasons: ["stop"],
        },
    });
    assert.equal(line, "  ↳ wire: 8 chunks, 4 carried nothing, reasoning_content×1, tool_calls×2, refusal×1, tool call READ({\"path\": \"django/views/debug.py\"}), refusal: no");
    assert.equal(DigestRender.wireLine({ content: "" }), null, "a record without a wire says nothing about it");
});

test("{§exec-env-scoped} the digest names a spawn's environment with each value's provenance", () => {
    const line = DigestRender.envLine({
        PATH: { source: "host", value: "/usr/bin" },
        HOME: { source: "host", value: "/home/x" },
        CARGO_TARGET_DIR: { source: "worker", value: "/tmp/shared" },
        TOOLCHAIN: { source: "worker", from: "alice", value: "stable" },
        CI: { source: "masked" },
        NO_COLOR: { source: "masked", from: "alice" },
        RUN_ID: { source: "modifier", value: "7" },
        NODE_ENV: { source: "workspace", value: "production" },
    });
    assert.equal(line, "env: host HOME,PATH · CARGO_TARGET_DIR=/tmp/shared (worker) · CI (masked) · NO_COLOR (masked by alice) · NODE_ENV=production (workspace) · RUN_ID=7 (modifier) · TOOLCHAIN=stable (from alice)");
    assert.equal(DigestRender.envLine({}), "env: (empty)", "an empty environment is a fact, not an absence");
    assert.equal(DigestRender.envLine(undefined), null, "an output without a recorded environment renders none");
});
