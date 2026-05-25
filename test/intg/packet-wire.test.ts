import test from "node:test";
import assert from "node:assert/strict";
import { renderSystemContent } from "../../src/core/packet-wire.js";

// Default-channel convention: when a channel's name matches its scheme's
// defaultChannel, the heredoc fence is path-only (no `#channel` suffix).
// The absence of a suffix IS the addressing of the default channel.

test("index entry: file scheme renders bare path (no file:// leak to model)", () => {
    const system = {
        system_definition: "SD",
        persona: "",
        index: [{
            scheme: "file",
            pathname: "notes.md",
            defaultChannel: "body",
            channels: { body: { content: "hello", mimetype: "text/markdown", tokens: 1 } },
        }],
        log: [],
    };
    const out = renderSystemContent(system);
    assert.doesNotMatch(out, /file:\/\//, "file:// must never appear in model-facing output");
    assert.match(out, /<<notes\.md:\n/, "fence carries bare pathname");
    assert.match(out, /:notes\.md$/m, "closing fence matches opening");
    assert.doesNotMatch(out, /#body/, "no #body anywhere — it is the default channel");
});

test("index entry: non-default channel keeps #suffix", () => {
    const system = {
        system_definition: "SD",
        persona: "",
        index: [{
            scheme: "exec",
            pathname: "build/log",
            defaultChannel: "stdout",
            channels: { stderr: { content: "warn: ...", mimetype: "text/plain", tokens: 1 } },
        }],
        log: [],
    };
    const out = renderSystemContent(system);
    assert.match(out, /<<exec:\/\/build\/log#stderr:/, "non-default channel keeps #stderr");
});

test("index entry: multi-channel entry omits suffix on default, keeps it on others", () => {
    const system = {
        system_definition: "SD",
        persona: "",
        index: [{
            scheme: "exec",
            pathname: "run",
            defaultChannel: "stdout",
            channels: {
                stdout: { content: "ok", mimetype: "text/plain", tokens: 1 },
                stderr: { content: "warn", mimetype: "text/plain", tokens: 1 },
            },
        }],
        log: [],
    };
    const out = renderSystemContent(system);
    assert.match(out, /<<exec:\/\/run:\n1:\tok\n:exec:\/\/run/, "stdout fence is path-only");
    assert.match(out, /<<exec:\/\/run#stderr:\n1:\twarn\n:exec:\/\/run#stderr/, "stderr fence keeps #stderr");
});

test("log entry: response fence carries /op suffix for wire self-documentation, no #channel", () => {
    const system = {
        system_definition: "SD",
        persona: "",
        index: [],
        log: [{
            coordinate: "1/1/1",
            origin: "model",
            op: "EDIT",
            status: 200,
            target: { scheme: "file", pathname: "out.txt" },
            rx: "{\"status\":200}",
        }],
    };
    const out = renderSystemContent(system);
    assert.match(out, /<<log:\/\/1\/1\/1\/EDIT:\n/, "log fence carries /EDIT suffix");
    assert.match(out, /:log:\/\/1\/1\/1\/EDIT$/m, "closing fence matches with suffix");
    assert.doesNotMatch(out, /log:\/\/[^\n]*#/, "no #channel on log fences (logs are single-payload)");
});
