import test from "node:test";
import assert from "node:assert/strict";
import PacketWire from "../../src/core/packet-wire.ts";

// Default-channel convention: when a channel's name matches its scheme's
// defaultChannel, the heredoc fence is path-only (no `#channel` suffix).
// The absence of a suffix IS the addressing of the default channel.

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
            target: { scheme: null, pathname: "/out.txt" },
            rx: "{\"status\":200}",
        }],
    };
    const out = PacketWire.renderSystemContent(system);
    assert.match(out, /\* \{"op":"EDIT","origin":"model","path":"log:\/\/\/1\/1\/1\/EDIT","status":200,"target":"\/out\.txt"\}/, "single meta line; path = log URI identity; target = action operand");
});

test("[§render-rule-line-navigable-prefix] log render: READ@200 with text/markdown rx body → line-numbered heredoc", () => {
    const system = {
        system_definition: "SD",
        persona: "",
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
    const out = PacketWire.renderSystemContent(system);
    // Line-navigable mimetype → `N:\t` prefix per line.
    assert.match(out, /<<:::\/notes\.md\n1:\thello\n2:\tworld\n:::\/notes\.md/);
});

test("[§render-rule-tree-navigable-verbatim] log render: READ@200 with application/json rx body → verbatim heredoc (no N:\\t)", () => {
    const system = {
        system_definition: "SD",
        persona: "",
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
    const out = PacketWire.renderSystemContent(system);
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
                target: { kind: "url", raw: "known:///users.json", scheme: "known", pathname: "/users.json", fragment: null },
                body: '[{"name":"Eve"}]',
                signal: null,
                lineMarker: null,
            },
            rx: { status: 200, entryId: 5, channel: "body" },
        }],
    };
    const out = PacketWire.renderSystemContent(system);
    // Body has no leading/trailing whitespace; render is single-line — no
    // `\n` padding added on the way back. Character-perfect mirror of tx.
    assert.match(out, /<<EDIT\(known:\/\/\/users\.json\):\[\{"name":"Eve"\}\]:EDIT/);
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
                target: { kind: "url", raw: "known:///users.json", scheme: "known", pathname: "/users.json", fragment: null },
                body: '[{"name":"Alice"}]',
                signal: null,
                lineMarker: null,
            },
            rx: { status: 201, entryId: 5, channel: "body" },
        }],
    };
    const out = PacketWire.renderSystemContent(system);
    assert.match(out, /<<EDIT\(known:\/\/\/users\.json\):\[\{"name":"Alice"\}\]:EDIT/);
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
    const out = PacketWire.renderSystemContent(system);
    assert.match(out, /<<EDIT\(known:\/\/\/plan\):\n- \[ \] step a\n- \[ \] step b\n:EDIT/);
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
    const out = PacketWire.renderSystemContent(system);
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
                target: { kind: "url", raw: "known:///notes", scheme: "known", pathname: "/notes", fragment: null },
                body: "revised",
                signal: null,
                lineMarker: { first: 5, last: null },
            },
            rx: { status: 200, entryId: 5, channel: "body" },
        }],
    };
    const out = PacketWire.renderSystemContent(system);
    assert.match(out, /<<EDIT\(known:\/\/\/notes\)<5>:revised:EDIT/);
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
                target: { kind: "url", raw: "known:///x", scheme: "known", pathname: "/x", fragment: null },
                body: "body",
                signal: ["alpha", "beta"],
                lineMarker: { first: 3, last: 7 },
            },
            rx: { status: 200, entryId: 5, channel: "body" },
        }],
    };
    const out = PacketWire.renderSystemContent(system);
    assert.match(out, /<<EDIT\[alpha,beta\]\(known:\/\/\/x\)<3,7>:body:EDIT/);
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
                target: { kind: "url", raw: "known:///x#preview", scheme: "known", pathname: "/x", fragment: "preview" },
                body: "summary",
                signal: null,
                lineMarker: null,
            },
            rx: { status: 200, entryId: 5, channel: "preview" },
        }],
    };
    const out = PacketWire.renderSystemContent(system);
    assert.match(out, /<<EDIT\(known:\/\/\/x#preview\):summary:EDIT/);
});

test("measureBudgetSections: per-section render tokens + assembled total (log only)", () => {
    const tk = (s: string) => s.length; // deterministic: one token per char
    const packet = {
        system: {
            system_definition: "SD",
            persona: "",
            log: [],
        },
        user: { prompt: "go", telemetry: { budget: "{{tokensFree}}", errors: [] }, system_requirements: "" },
    };
    const m = PacketWire.measureBudgetSections(packet, tk);
    assert.equal(m.log.entries, 0);
    assert.equal(m.log.tokens, 0, "no log section → zero tokens");
    // total is the real assembled wire (placeholder budget included), proving
    // it measures the render rather than a serialized stand-in.
    assert.equal(m.total, PacketWire.renderSystemContent(packet.system).length + PacketWire.renderUserContent(packet.user).length);
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
    const out = PacketWire.renderUserContent(user);
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
    const out = PacketWire.renderUserContent(user);
    assert.match(out, /\* \{"coordinate":"1\/1\/2","error":"writer 'model' denied on scheme 'log'","kind":"action_failure","op":"EDIT","status":403,"target":"log:\/\/\/x"\}/);
    assert.doesNotMatch(out, /<<error:\/\//);
});

test("[§requirements-requirements-render-last] system_requirements renders LAST in the user packet, under its own header", () => {
    const user = {
        prompt: "Reply with just the number.",
        telemetry: { budget: "5000 free", errors: [{ kind: "no_ops", coordinate: "1/1/1" }] },
        system_requirements: "Conclude the loop with <<SEND[200]:answer:SEND",
    };
    const out = PacketWire.renderUserContent(user);
    // §requirements: requirements is the contract that must win conflicts with the
    // natural-language prompt, so it renders closest to the assistant turn —
    // after the prompt, budget, and errors, with nothing following it.
    assert.match(out, /# Plurnk System Requirements\n\nConclude the loop with <<SEND\[200\]:answer:SEND$/,
        "requirements renders LAST under its own header, nothing after it");
    const reqIdx = out.indexOf("# Plurnk System Requirements");
    assert.ok(reqIdx > out.indexOf("# Plurnk System User Prompt"), "requirements follows the prompt");
    const teleIdx = out.indexOf("# Plurnk System Telemetry");
    assert.ok(teleIdx > 0 && reqIdx > teleIdx, "requirements follows the telemetry block");
    assert.ok(reqIdx > out.indexOf("## Budget"), "requirements follows the budget subsection");
    assert.ok(reqIdx > out.indexOf("## Errors"), "requirements follows the errors subsection");
});

test("[§requirements-requirements-omitted-when-empty] empty system_requirements emits no header", () => {
    const out = PacketWire.renderUserContent({ prompt: "P", telemetry: { budget: "", errors: [] }, system_requirements: "" });
    assert.doesNotMatch(out, /# Plurnk System Requirements/, "no requirements section when the string is empty");
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
            target: { scheme: null, pathname: "/page.html" },
            rx: { content: "<h1>Hi</h1>", mimetype: "text/html" },
        }],
    };
    const out = PacketWire.renderSystemContent(system);
    assert.match(out, /<<:::\/page\.html\n<h1>Hi<\/h1>\n:::\/page\.html/);
    assert.doesNotMatch(out, /1:\t/);
});
