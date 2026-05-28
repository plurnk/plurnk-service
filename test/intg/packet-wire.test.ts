import test from "node:test";
import assert from "node:assert/strict";
import { renderSystemContent } from "../../src/core/packet-wire.js";

// Default-channel convention: when a channel's name matches its scheme's
// defaultChannel, the heredoc fence is path-only (no `#channel` suffix).
// The absence of a suffix IS the addressing of the default channel.

test("index entry: null scheme renders bare path (file scheme normalized to null at storage)", () => {
    // file-scheme rows store scheme=NULL per Engine.#extractTarget; the
    // renderer's only job here is to honor null → bare pathname. The
    // literal "file" string never reaches packet-wire — that's the
    // architectural guarantee (entries.scheme never holds "file").
    const system = {
        system_definition: "SD",
        persona: "",
        index: [{
            scheme: null,
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

test("log entry: renders as a single JSON meta line — path is log URI, target is action operand", () => {
    const system = {
        system_definition: "SD",
        persona: "",
        index: [],
        log: [{
            coordinate: "1/1/1",
            origin: "model",
            op: "EDIT",
            status: 200,
            target: { scheme: null, pathname: "out.txt" },
            rx: "{\"status\":200}",
        }],
    };
    const out = renderSystemContent(system);
    assert.match(out, /\* \{"op":"EDIT","origin":"model","path":"log:\/\/1\/1\/1\/EDIT","status":200,"target":"out\.txt"\}/, "single meta line; path = log URI identity; target = action operand");
});

test("log render: READ@200 with text/markdown rx body → line-numbered heredoc", () => {
    const system = {
        system_definition: "SD",
        persona: "",
        index: [],
        log: [{
            coordinate: "1/1/2",
            origin: "model",
            op: "READ",
            status: 200,
            target: { scheme: null, pathname: "notes.md" },
            rx: { content: "hello\nworld", mimetype: "text/markdown", startLine: 1 },
        }],
    };
    const out = renderSystemContent(system);
    // Line-navigable mimetype → `N:\t` prefix per line.
    assert.match(out, /<<notes\.md:\n1:\thello\n2:\tworld\n:notes\.md/);
});

test("log render: READ@200 with application/json rx body → verbatim heredoc (no N:\\t)", () => {
    const system = {
        system_definition: "SD",
        persona: "",
        index: [],
        log: [{
            coordinate: "1/1/2",
            origin: "model",
            op: "READ",
            status: 200,
            target: { scheme: null, pathname: "notes.md" },
            rx: { content: '[\n  {"line":1,"matched":"hello"}\n]', mimetype: "application/json" },
        }],
    };
    const out = renderSystemContent(system);
    // Tree-navigable mimetype → body rendered verbatim, no outer N:\t.
    assert.match(out, /<<notes\.md:\n\[\n {2}\{"line":1,"matched":"hello"\}\n\]\n:notes\.md/);
    assert.doesNotMatch(out, /<<notes\.md:\n1:\t/);
});

test("log render: READ@200 with text/html rx body → verbatim heredoc (tree-navigable)", () => {
    const system = {
        system_definition: "SD",
        persona: "",
        index: [],
        log: [{
            coordinate: "1/1/2",
            origin: "model",
            op: "READ",
            status: 200,
            target: { scheme: null, pathname: "page.html" },
            rx: { content: "<h1>Hi</h1>", mimetype: "text/html" },
        }],
    };
    const out = renderSystemContent(system);
    assert.match(out, /<<page\.html:\n<h1>Hi<\/h1>\n:page\.html/);
    assert.doesNotMatch(out, /1:\t/);
});
