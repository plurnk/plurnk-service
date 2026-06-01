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
    assert.match(out, /<<:::notes\.md\n/, "fence carries bare pathname");
    assert.match(out, /:::notes\.md$/m, "closing fence matches opening");
    assert.doesNotMatch(out, /#body/, "no #body anywhere — it is the default channel");
});

test("[regression] entry projection wears the non-emittable <<:::path marker, never the op-lookalike <<path: (demo.sh fence-leak guard)", () => {
    const system = {
        system_definition: "",
        persona: "",
        index: [{
            scheme: null,
            pathname: "demo.sh",
            defaultChannel: "body",
            channels: { body: { content: "#!/bin/bash\necho hi", mimetype: "text/plain", tokens: 1 } },
        }],
        log: [],
    };
    const out = renderSystemContent(system);
    // The projection wears the `<<:::path` packet-rendering marker, which
    // cannot parse as an emittable op (op tags are words, never `:::`).
    assert.match(out, /<<:::demo\.sh\n/, "opening :::path marker");
    assert.match(out, /\n:::demo\.sh/, "closing :::path marker");
    // It must NOT wear the old `<<path:…:path` op-lookalike — that form made
    // the model copy the `:demo.sh` close into an EDIT body, the parser
    // greedy-swallowed the rest of the emission, and the garbage hit disk
    // and broke exec. See the fence-leak postmortem.
    assert.doesNotMatch(out, /<<demo\.sh:/, "no op-lookalike opening");
    assert.doesNotMatch(out, /\n:demo\.sh/, "no op-lookalike closing");
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
    assert.match(out, /<<:::exec:\/\/build\/log#stderr\n/, "non-default channel keeps #stderr");
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
    assert.match(out, /<<:::exec:\/\/run\n1:\tok\n:::exec:\/\/run/, "stdout fence is path-only");
    assert.match(out, /<<:::exec:\/\/run#stderr\n1:\twarn\n:::exec:\/\/run#stderr/, "stderr fence keeps #stderr");
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
    assert.match(out, /<<:::notes\.md\n1:\thello\n2:\tworld\n:::notes\.md/);
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
    assert.match(out, /<<:::notes\.md\n\[\n {2}\{"line":1,"matched":"hello"\}\n\]\n:::notes\.md/);
    assert.doesNotMatch(out, /<<:::notes\.md\n1:\t/);
});

// EDIT log renders re-emit the model's statement as heredoc — same syntax
// the model would write to cause this state. No udiff in the model's
// packet (that format belongs in client communication, where humans want
// colored before/after rendering).

test("log render: EDIT@200 — re-emit the statement in heredoc form", () => {
    const system = {
        system_definition: "SD",
        persona: "",
        index: [],
        log: [{
            coordinate: "1/1/2",
            origin: "model",
            op: "EDIT",
            status: 200,
            target: { scheme: "known", pathname: "/users.json" },
            tx: {
                op: "EDIT",
                suffix: "",
                target: { kind: "url", raw: "known://users.json", scheme: "known", pathname: "/users.json", fragment: null },
                body: '[{"name":"Eve"}]',
                signal: null,
                lineMarker: null,
            },
            rx: { status: 200, entryId: 5, channel: "body" },
        }],
    };
    const out = renderSystemContent(system);
    // Body has no leading/trailing whitespace; render is single-line — no
    // `\n` padding added on the way back. Character-perfect mirror of tx.
    assert.match(out, /<<EDIT\(known:\/\/users\.json\):\[\{"name":"Eve"\}\]:EDIT/);
});

test("log render: EDIT@201 (entry created) — heredoc with full body", () => {
    const system = {
        system_definition: "SD",
        persona: "",
        index: [],
        log: [{
            coordinate: "1/1/1",
            origin: "model",
            op: "EDIT",
            status: 201,
            target: { scheme: "known", pathname: "/users.json" },
            tx: {
                op: "EDIT",
                suffix: "",
                target: { kind: "url", raw: "known://users.json", scheme: "known", pathname: "/users.json", fragment: null },
                body: '[{"name":"Alice"}]',
                signal: null,
                lineMarker: null,
            },
            rx: { status: 201, entryId: 5, channel: "body" },
        }],
    };
    const out = renderSystemContent(system);
    assert.match(out, /<<EDIT\(known:\/\/users\.json\):\[\{"name":"Alice"\}\]:EDIT/);
});

test("log render: EDIT with multi-line body — body's own newlines decide shape (no added padding)", () => {
    const system = {
        system_definition: "SD",
        persona: "",
        index: [],
        log: [{
            coordinate: "1/1/4",
            origin: "model",
            op: "EDIT",
            status: 201,
            target: { scheme: "known", pathname: "/plan" },
            tx: {
                op: "EDIT",
                suffix: "",
                target: { kind: "url", raw: "known://plan", scheme: "known", pathname: "/plan", fragment: null },
                // Model emitted with newlines around the body — those
                // newlines are part of the body. Render mirrors verbatim.
                body: "\n- [ ] step a\n- [ ] step b\n",
                signal: null,
                lineMarker: null,
            },
            rx: { status: 201, entryId: 5, channel: "body" },
        }],
    };
    const out = renderSystemContent(system);
    assert.match(out, /<<EDIT\(known:\/\/plan\):\n- \[ \] step a\n- \[ \] step b\n:EDIT/);
});

test("log render: EDIT@200 with no tx → meta line only (defensive — tx is always written in practice)", () => {
    const system = {
        system_definition: "SD",
        persona: "",
        index: [],
        log: [{
            coordinate: "1/1/3",
            origin: "model",
            op: "EDIT",
            status: 200,
            target: { scheme: "known", pathname: "/x" },
            rx: { status: 200, entryId: 5, channel: "body" },
        }],
    };
    const out = renderSystemContent(system);
    assert.doesNotMatch(out, /<<EDIT\(/);
});

test("log render: EDIT with line marker — heredoc carries the marker", () => {
    const system = {
        system_definition: "SD", persona: "", index: [],
        log: [{
            coordinate: "1/1/5",
            origin: "model",
            op: "EDIT",
            status: 200,
            target: { scheme: "known", pathname: "/notes" },
            tx: {
                op: "EDIT",
                suffix: "",
                target: { kind: "url", raw: "known://notes", scheme: "known", pathname: "/notes", fragment: null },
                body: "revised",
                signal: null,
                lineMarker: { first: 5, last: null },
            },
            rx: { status: 200, entryId: 5, channel: "body" },
        }],
    };
    const out = renderSystemContent(system);
    assert.match(out, /<<EDIT\(known:\/\/notes\)<5>:revised:EDIT/);
});

test("log render: EDIT with tags and range marker — heredoc carries both", () => {
    const system = {
        system_definition: "SD", persona: "", index: [],
        log: [{
            coordinate: "1/1/6",
            origin: "model",
            op: "EDIT",
            status: 200,
            target: { scheme: "known", pathname: "/x" },
            tx: {
                op: "EDIT",
                suffix: "",
                target: { kind: "url", raw: "known://x", scheme: "known", pathname: "/x", fragment: null },
                body: "body",
                signal: ["alpha", "beta"],
                lineMarker: { first: 3, last: 7 },
            },
            rx: { status: 200, entryId: 5, channel: "body" },
        }],
    };
    const out = renderSystemContent(system);
    assert.match(out, /<<EDIT\[alpha,beta\]\(known:\/\/x\)<3,7>:body:EDIT/);
});

test("log render: EDIT with fragment in target.raw — heredoc preserves it", () => {
    const system = {
        system_definition: "SD", persona: "", index: [],
        log: [{
            coordinate: "1/1/7",
            origin: "model",
            op: "EDIT",
            status: 200,
            target: { scheme: "known", pathname: "/x" },
            tx: {
                op: "EDIT",
                suffix: "",
                target: { kind: "url", raw: "known://x#preview", scheme: "known", pathname: "/x", fragment: "preview" },
                body: "summary",
                signal: null,
                lineMarker: null,
            },
            rx: { status: 200, entryId: 5, channel: "preview" },
        }],
    };
    const out = renderSystemContent(system);
    assert.match(out, /<<EDIT\(known:\/\/x#preview\):summary:EDIT/);
});

test("index entry: body ending in newline does NOT produce a doubled trailing newline", () => {
    // Shell streams (ls, find, etc.) end with \n. Without the fix,
    // numberLines preserves the trailing \n and the heredoc wrapper
    // adds another, producing a blank line before the closing fence
    // that looks like the content has a trailing blank line.
    const system = {
        system_definition: "SD",
        persona: "",
        index: [{
            scheme: "exec",
            pathname: "1/2/1/EXEC",
            defaultChannel: "stdout",
            channels: { stdout: { content: "data/\nnotes.md\npackage.json\nsrc/\n", mimetype: "text/stream", tokens: 0 } },
        }],
        log: [],
    };
    const out = renderSystemContent(system);
    // Expect exactly one newline between `src/` and the closing fence.
    assert.match(out, /4:\tsrc\/\n:::exec:\/\/1\/2\/1\/EXEC/);
    assert.doesNotMatch(out, /4:\tsrc\/\n\n:::exec:\/\/1\/2\/1\/EXEC/);
});

test("telemetry render: parse_error with snippet → meta line followed by N:\\t-prefixed snippet body", () => {
    const user = {
        prompt: "P",
        telemetry: {
            budget: "",
            errors: [{
                source: "grammar",
                kind: "parse_error",
                message: "invalid xpath: Unexpected character :",
                position: { type: "content-offset", line: 1, column: 0 },
                snippet: "1:\t<<READ(src/app.js):// TODO: add error handling:READ",
                parserSource: "visitor",
            }],
        },
    };
    const out = renderUserContent(user);
    // Meta line lists structured fields but NOT `snippet` (it's broken
    // out into the body block instead). canonicalJson sorts top-level
    // keys; nested objects keep insertion order.
    assert.match(out, /\* \{"kind":"parse_error","message":"invalid xpath: Unexpected character :","parserSource":"visitor","position":\{"type":"content-offset","line":1,"column":0\},"source":"grammar"\}/);
    assert.doesNotMatch(out, /"snippet":/);
    // Snippet rendered under `error://<line>` fence.
    assert.match(out, /<<:::error:\/\/1\n1:\t<<READ\(src\/app\.js\):\/\/ TODO: add error handling:READ\n:::error:\/\/1/);
});

test("telemetry render: telemetry without snippet → meta-only (no fence)", () => {
    const user = {
        prompt: "P",
        telemetry: {
            budget: "",
            errors: [{ kind: "action_failure", coordinate: "1/1/2", op: "EDIT", status: 403, target: "log:///x", error: "writer 'model' denied on scheme 'log'" }],
        },
    };
    const out = renderUserContent(user);
    assert.match(out, /\* \{"coordinate":"1\/1\/2","error":"writer 'model' denied on scheme 'log'","kind":"action_failure","op":"EDIT","status":403,"target":"log:\/\/\/x"\}/);
    assert.doesNotMatch(out, /<<error:\/\//);
});

import { renderUserContent } from "../../src/core/packet-wire.js";

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
    assert.match(out, /<<:::page\.html\n<h1>Hi<\/h1>\n:::page\.html/);
    assert.doesNotMatch(out, /1:\t/);
});
