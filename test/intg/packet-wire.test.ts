import test from "node:test";
import assert from "node:assert/strict";
import PacketWire from "../../src/core/packet-wire.ts";

// Default-channel convention: when a channel's name matches its scheme's
// defaultChannel, the heredoc fence is path-only (no `#channel` suffix).
// The absence of a suffix IS the addressing of the default channel.

test("log entry: renders as a single JSON meta line — path is log URI, target is action operand", () => {
    const system = {
        system_definition: "SD",
        index: [],
        log: [{
            coordinate: "1/1/1",
            origin: "model",
            op: "EDIT",
            status: 200,
            target: { scheme: null, pathname: "/out.txt" },
            rx: "{\"status\":200}",
        }],
    };
    const out = PacketWire.renderLog(system.log);
    assert.match(out, /\* \{"op":"EDIT","origin":"model","path":"log:\/\/\/1\/1\/1\/EDIT","status":200,"target":"\/out\.txt"\}/, "single meta line; path = log URI identity; target = action operand");
});

test("[§render-rule-line-navigable-prefix] log render: READ@200 with text/markdown rx body → line-numbered heredoc", () => {
    const system = {
        system_definition: "SD",
        index: [],
        log: [{
            coordinate: "1/1/2",
            origin: "model",
            op: "READ",
            status: 200,
            target: { scheme: null, pathname: "/notes.md" },
            rx: { content: "hello\nworld", mimetype: "text/markdown", startLine: 1 },
        }],
    };
    const out = PacketWire.renderLog(system.log);
    // Line-navigable mimetype → `N:\t` prefix per line.
    assert.match(out, /<<:::\/notes\.md\n1:\thello\n2:\tworld\n:::\/notes\.md/);
});

test("[§render-rule-tree-navigable-verbatim] log render: READ@200 with application/json rx body → verbatim heredoc (no N:\\t)", () => {
    const system = {
        system_definition: "SD",
        index: [],
        log: [{
            coordinate: "1/1/2",
            origin: "model",
            op: "READ",
            status: 200,
            target: { scheme: null, pathname: "/notes.md" },
            rx: { content: '[\n  {"line":1,"matched":"hello"}\n]', mimetype: "application/json" },
        }],
    };
    const out = PacketWire.renderLog(system.log);
    // Tree-navigable mimetype → body rendered verbatim, no outer N:\t.
    assert.match(out, /<<:::\/notes\.md\n\[\n {2}\{"line":1,"matched":"hello"\}\n\]\n:::\/notes\.md/);
    assert.doesNotMatch(out, /<<:::\/notes\.md\n1:\t/);
});

// EDIT log renders re-emit the model's statement as heredoc — same syntax
// the model would write to cause this state. No udiff in the model's
// packet (that format belongs in client communication, where humans want
// colored before/after rendering).

test("log render: EDIT@200 — re-emit the statement in heredoc form", () => {
    const system = {
        system_definition: "SD",
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
                target: { kind: "url", raw: "known:///users.json", scheme: "known", pathname: "/users.json", fragment: null },
                body: '[{"name":"Eve"}]',
                signal: null,
                lineMarker: null,
            },
            rx: { status: 200, entryId: 5, channel: "body" },
        }],
    };
    const out = PacketWire.renderLog(system.log);
    // Body has no leading/trailing whitespace; render is single-line — no
    // `\n` padding added on the way back. Character-perfect mirror of tx.
    assert.match(out, /<<EDIT\(known:\/\/\/users\.json\):\[\{"name":"Eve"\}\]:EDIT/);
});

test("log render: EDIT@201 (entry created) — heredoc with full body", () => {
    const system = {
        system_definition: "SD",
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
                target: { kind: "url", raw: "known:///users.json", scheme: "known", pathname: "/users.json", fragment: null },
                body: '[{"name":"Alice"}]',
                signal: null,
                lineMarker: null,
            },
            rx: { status: 201, entryId: 5, channel: "body" },
        }],
    };
    const out = PacketWire.renderLog(system.log);
    assert.match(out, /<<EDIT\(known:\/\/\/users\.json\):\[\{"name":"Alice"\}\]:EDIT/);
});

test("log render: EDIT with multi-line body — body's own newlines decide shape (no added padding)", () => {
    const system = {
        system_definition: "SD",
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
                target: { kind: "url", raw: "known:///plan", scheme: "known", pathname: "/plan", fragment: null },
                // Model emitted with newlines around the body — those
                // newlines are part of the body. Render mirrors verbatim.
                body: "\n- [ ] step a\n- [ ] step b\n",
                signal: null,
                lineMarker: null,
            },
            rx: { status: 201, entryId: 5, channel: "body" },
        }],
    };
    const out = PacketWire.renderLog(system.log);
    assert.match(out, /<<EDIT\(known:\/\/\/plan\):\n- \[ \] step a\n- \[ \] step b\n:EDIT/);
});

test("log render: EDIT@200 with no tx → meta line only (defensive — tx is always written in practice)", () => {
    const system = {
        system_definition: "SD",
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
    const out = PacketWire.renderLog(system.log);
    assert.doesNotMatch(out, /<<EDIT\(/);
});

test("log render: EDIT with line marker — heredoc carries the marker", () => {
    const system = {
        system_definition: "SD", index: [],
        log: [{
            coordinate: "1/1/5",
            origin: "model",
            op: "EDIT",
            status: 200,
            target: { scheme: "known", pathname: "/notes" },
            tx: {
                op: "EDIT",
                suffix: "",
                target: { kind: "url", raw: "known:///notes", scheme: "known", pathname: "/notes", fragment: null },
                body: "revised",
                signal: null,
                lineMarker: { marks: [5] },
            },
            rx: { status: 200, entryId: 5, channel: "body" },
        }],
    };
    const out = PacketWire.renderLog(system.log);
    assert.match(out, /<<EDIT\(known:\/\/\/notes\)<5>:revised:EDIT/);
});

test("log render: EDIT with tags and range marker — heredoc carries both", () => {
    const system = {
        system_definition: "SD", index: [],
        log: [{
            coordinate: "1/1/6",
            origin: "model",
            op: "EDIT",
            status: 200,
            target: { scheme: "known", pathname: "/x" },
            tx: {
                op: "EDIT",
                suffix: "",
                target: { kind: "url", raw: "known:///x", scheme: "known", pathname: "/x", fragment: null },
                body: "body",
                signal: ["alpha", "beta"],
                lineMarker: { marks: [3, 7] },
            },
            rx: { status: 200, entryId: 5, channel: "body" },
        }],
    };
    const out = PacketWire.renderLog(system.log);
    assert.match(out, /<<EDIT\[alpha,beta\]\(known:\/\/\/x\)<3,7>:body:EDIT/);
});

test("log render: EDIT with fragment in target.raw — heredoc preserves it", () => {
    const system = {
        system_definition: "SD", index: [],
        log: [{
            coordinate: "1/1/7",
            origin: "model",
            op: "EDIT",
            status: 200,
            target: { scheme: "known", pathname: "/x" },
            tx: {
                op: "EDIT",
                suffix: "",
                target: { kind: "url", raw: "known:///x#preview", scheme: "known", pathname: "/x", fragment: "preview" },
                body: "summary",
                signal: null,
                lineMarker: null,
            },
            rx: { status: 200, entryId: 5, channel: "preview" },
        }],
    };
    const out = PacketWire.renderLog(system.log);
    assert.match(out, /<<EDIT\(known:\/\/\/x#preview\):summary:EDIT/);
});

test("measureLogBudget: log subtotals (entries, tokens, byTurn, largest) from the structured log", () => {
    const tk = (s: string) => s.length; // deterministic: one token per char
    const empty = PacketWire.measureLogBudget([], tk);
    assert.equal(empty.entries, 0);
    assert.equal(empty.tokens, 0, "no log entries → zero tokens");
    assert.deepEqual(empty.byTurn, []);
    assert.deepEqual(empty.largest, []);
    // One entry: tokens are the headed-log render-weight; byTurn keys on loop/turn;
    // largest names the entry by its log:/// handle.
    const one = PacketWire.measureLogBudget(
        [{ coordinate: "1/1/1", op: "EDIT", origin: "model", status: 200, target: { scheme: null, pathname: "/x" } }],
        tk,
    );
    assert.equal(one.entries, 1);
    assert.ok(one.tokens > 0, "a log entry has render-weight");
    assert.equal(one.byTurn[0].turn, "1/1");
    assert.equal(one.largest[0].path, "log:///1/1/1/EDIT");
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
    const out = PacketWire.renderErrors(user.telemetry.errors);
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
    const out = PacketWire.renderErrors(user.telemetry.errors);
    assert.match(out, /\* \{"coordinate":"1\/1\/2","error":"writer 'model' denied on scheme 'log'","kind":"action_failure","op":"EDIT","status":403,"target":"log:\/\/\/x"\}/);
    assert.doesNotMatch(out, /<<error:\/\//);
});

test("[§requirements-requirements-render-last] requirements renders LAST in the user slot, under its own header", () => {
    // The default packet orders the user slot prompt → budget → errors → … →
    // requirements; renderSlot preserves that order, so requirements lands last.
    const out = PacketWire.renderSlot([
        { name: "prompt", slot: "user", header: "Plurnk System User Prompt", content: "Reply with just the number.", tokens: 0 },
        { name: "budget", slot: "user", header: "Plurnk System Budget", content: "5000 free", tokens: 0 },
        { name: "errors", slot: "user", header: "Plurnk System Errors", content: PacketWire.renderErrors([{ kind: "no_ops", coordinate: "1/1/1" }]), tokens: 0 },
        { name: "requirements", slot: "user", header: "Plurnk System Requirements", content: "Conclude the loop with <<SEND[200]:answer:SEND", tokens: 0 },
    ], "user");
    // §requirements: requirements is the contract that must win conflicts with the
    // natural-language prompt, so it renders closest to the assistant turn —
    // after the prompt, budget, and errors, with nothing following it.
    assert.match(out, /# Plurnk System Requirements\n\nConclude the loop with <<SEND\[200\]:answer:SEND$/,
        "requirements renders LAST under its own header, nothing after it");
    const reqIdx = out.indexOf("# Plurnk System Requirements");
    assert.ok(reqIdx > out.indexOf("# Plurnk System User Prompt"), "requirements follows the prompt");
    assert.ok(reqIdx > out.indexOf("# Plurnk System Budget"), "requirements follows the budget section");
    assert.ok(reqIdx > out.indexOf("# Plurnk System Errors"), "requirements follows the errors section");
});

test("[§requirements-requirements-omitted-when-empty] empty requirements section emits no header", () => {
    const out = PacketWire.renderSlot([
        { name: "prompt", slot: "user", header: "Plurnk System User Prompt", content: "P", tokens: 0 },
        { name: "requirements", slot: "user", header: "Plurnk System Requirements", content: "", tokens: 0 },
    ], "user");
    assert.doesNotMatch(out, /# Plurnk System Requirements/, "no requirements section when the content is empty");
});

test("renderCatalog: per-scheme tally — counts + tokens, null scheme → file, count is pluralized", () => {
    const out = PacketWire.renderCatalog([
        { scheme: "known", entries: 5, tokens: 1240 },
        { scheme: null, entries: 1, tokens: 80 },
    ]);
    assert.equal(out, "known — 5 entries, 1240 tokens\nfile — 1 entry, 80 tokens");
});

test("renderCatalog: empty/non-array → '' so the section is omitted, never throws", () => {
    assert.equal(PacketWire.renderCatalog([]), "", "no schemes → no catalog section");
    assert.equal(PacketWire.renderCatalog(undefined), "", "non-array tolerated as empty");
});



test("[§render-rule-find-renders-result] log render: FIND@200 renders its result catalog, not just the echoed query", () => {
    // The turn-0 foisted FIND(scheme:///**) is how a run's opening catalog reaches
    // the packet. If the renderer only re-emits the query statement (the regression),
    // the model is shown its own question and zero entries.
    const catalog = '[\n  {\n    "path": "plurnk://prompt/1/1",\n    "channels": {\n      "plurnk://prompt/1/1": { "mimetype": "text/markdown", "tokens": 20, "lines": 1 }\n    }\n  }\n]';
    const out = PacketWire.renderLog([{
        coordinate: "1/1/2",
        origin: "plurnk",
        op: "FIND",
        status: 200,
        target: { scheme: "plurnk", pathname: "" },
        tx: { op: "FIND", suffix: "", target: { kind: "url", raw: "plurnk:///**", scheme: "plurnk", pathname: "", fragment: null }, body: null, signal: null, lineMarker: null },
        rx: { content: catalog, mimetype: "application/json" },
    }]);
    assert.match(out, /"path": "plurnk:\/\/prompt\/1\/1"/, "FIND@200 renders its result body — the model sees what the FIND returned");
    // Tree-navigable JSON → verbatim, no N:\t line-number prefix.
    assert.doesNotMatch(out, /\n1:\t/);
});

test("log render: READ@200 with text/html rx body → verbatim heredoc (tree-navigable)", () => {
    const system = {
        system_definition: "SD",
        index: [],
        log: [{
            coordinate: "1/1/2",
            origin: "model",
            op: "READ",
            status: 200,
            target: { scheme: null, pathname: "/page.html" },
            rx: { content: "<h1>Hi</h1>", mimetype: "text/html" },
        }],
    };
    const out = PacketWire.renderLog(system.log);
    assert.match(out, /<<:::\/page\.html\n<h1>Hi<\/h1>\n:::\/page\.html/);
    assert.doesNotMatch(out, /1:\t/);
});
