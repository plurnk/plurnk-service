import test from "node:test";
import assert from "node:assert/strict";
import PacketWire from "../../src/core/packet-wire.ts";

// These render tests assert on bodies/substrings, never on token VALUES — any
// deterministic tokenizer satisfies renderLog's signature (tokens land on the
// body-bearing meta lines, measured by this fn).
const tok = (s: string): number => Math.ceil(s.length / 4);

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
    const out = PacketWire.renderLog(system.log, tok);
    assert.match(out, /\* \{"op":"EDIT","origin":"model","path":"log:\/\/\/1\/1\/1\/EDIT","status":200,"target":"\/out\.txt","tokens":0\}/, "single meta line; path = log URI identity; target = action operand; tokens:0 on a no-body row");
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
    const out = PacketWire.renderLog(system.log, tok);
    // Line-navigable mimetype → `N:\t` prefix per line.
    assert.match(out, /<<:::\/notes\.md\n1:\thello\n2:\tworld\n:::\/notes\.md/);
});

test("log render: READ@200 matcher result (startLine null) renders VERBATIM — no double line-numbering", () => {
    // A matcher result is already source-numbered with non-contiguous lines (`143:\t…`,
    // `617:\t…`) and carries startLine=null. The render must NOT re-number it — that would
    // double it to `1:\t143:\t…` and lose the true source line (plurnk.md:32: one `N:\t`).
    const out = PacketWire.renderLog([{
        coordinate: "1/1/3",
        origin: "model",
        op: "READ",
        status: 200,
        target: { scheme: null, pathname: "/spec.md" },
        rx: { content: "143:\tgrinder\n617:\tgrinder", mimetype: "text/markdown", startLine: null },
    }], tok);
    assert.match(out, /<<:::\/spec\.md\n143:\tgrinder\n617:\tgrinder\n:::\/spec\.md/);
    assert.doesNotMatch(out, /1:\t143:\t/);
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
    const out = PacketWire.renderLog(system.log, tok);
    // Tree-navigable mimetype → body rendered verbatim, no outer N:\t.
    assert.match(out, /<<:::\/notes\.md\n\[\n {2}\{"line":1,"matched":"hello"\}\n\]\n:::\/notes\.md/);
    assert.doesNotMatch(out, /<<:::\/notes\.md\n1:\t/);
});

// EDIT log renders re-emit the model's statement as heredoc — same syntax
// the model would write to cause this state. No udiff in the model's
// packet (that format belongs in client communication, where humans want
// colored before/after rendering).

test("[§edit-result-render] log render: EDIT@200 with rx.span → wraps the pre-numbered span verbatim (editedSpan owns the offsets)", () => {
    const out = PacketWire.renderLog([{
        coordinate: "1/1/2",
        origin: "model",
        op: "EDIT",
        status: 200,
        target: { scheme: "known", pathname: "/plan.md" },
        rx: { status: 200, span: "3:\t- [x] ship the fix" },  // editedSpan emits N:\t with the changed region's REAL offset
    }], tok);
    // The model sees the edited area as it looks NOW at its TRUE line numbers — editedSpan already
    // line-numbered it, so the renderer wraps verbatim. Re-numbering here would double it (1:\t3:\t…)
    // and lose the real position. (A span-less EDIT — a scheme that returns no span — stands on its meta
    // line alone; the log NEVER re-serializes the op's emission tag, per the no-tags-in-the-log paradigm.)
    assert.match(out, /<<:::known:\/\/\/plan\.md\n3:\t- \[x\] ship the fix\n:::known:\/\/\/plan\.md/, "EDIT wraps the pre-numbered span verbatim under the target fence");
    assert.doesNotMatch(out, /1:\t3:\t/, "must NOT re-number an already-numbered span");
});

test("render guard: every content-emitting op applies the N:\\t convention uniformly (READ/FIND/EDIT/EXEC/stream/PLAN/SEND)", () => {
    // The model orients on line numbers, so EVERY op that emits a content body must number
    // line-navigable (text/*) bodies and leave tree-navigable (JSON) verbatim — else it has its
    // bearings on one op's output but not another's. Pins the invariant across READ, FIND, EDIT-span,
    // EXEC-body, the foisted exec-stream delta (incl. its cross-turn startLine), and PLAN/SEND bodies —
    // which ride into the log as N:\t content, NEVER re-serialized as a <<OP:…:OP tag (the log mirrors
    // the model's WORK, not its emission syntax). No future content branch can silently diverge.
    const base = { coordinate: "1/1/1", origin: "model", status: 200, target: { scheme: "known", pathname: "/a" } };
    const execTx = (body: string) => ({ op: "EXEC", suffix: "sh", target: { kind: "url", raw: "sh:///1/1/1", scheme: "sh", pathname: "/1/1/1", fragment: null }, body, signal: null, lineMarker: null });
    const cases: Array<{ label: string; entry: unknown; want: RegExp; anti?: RegExp }> = [
        { label: "READ text → numbered", entry: { ...base, op: "READ", rx: { status: 200, mimetype: "text/markdown", content: "alpha\nbeta" } }, want: /1:\talpha\n2:\tbeta/ },
        { label: "READ json → verbatim", entry: { ...base, op: "READ", rx: { status: 200, mimetype: "application/json", content: '{"k":1}' } }, want: /\n\{"k":1\}\n/, anti: /\d:\t/ },
        { label: "FIND text → numbered", entry: { ...base, op: "FIND", rx: { status: 200, mimetype: "text/markdown", content: "m1\nm2" } }, want: /1:\tm1\n2:\tm2/ },
        { label: "EDIT span → pre-numbered span preserved verbatim (editedSpan owns the real offsets)", entry: { ...base, op: "EDIT", rx: { status: 200, span: "5:\tx\n6:\ty" } }, want: /5:\tx\n6:\ty/, anti: /1:\t5:\t/ },
        { label: "EXEC body → numbered", entry: { ...base, op: "EXEC", target: { scheme: "sh", pathname: "/1/1/1" }, tx: execTx("ls\npwd") }, want: /1:\tls\n2:\tpwd/ },
        { label: "exec-stream delta → cross-turn startLine continues", entry: { ...base, op: "READ", origin: "plurnk", target: { scheme: "sh", pathname: "/1/1/1", fragment: "stdout" }, rx: { status: 200, mimetype: "text/stream", content: "out5\nout6", startLine: 5 } }, want: /5:\tout5\n6:\tout6/ },
        { label: "PLAN body → numbered content, never a <<PLAN tag", entry: { ...base, op: "PLAN", tx: { body: "read line 2\nthen answer" } }, want: /1:\tread line 2\n2:\tthen answer/, anti: /<<PLAN/ },
        { label: "SEND body → numbered content, never a <<SEND tag", entry: { ...base, op: "SEND", tx: { body: "here is the answer" } }, want: /1:\there is the answer/, anti: /<<SEND/ },
    ];
    for (const c of cases) {
        const out = PacketWire.renderLog([c.entry], tok);
        assert.match(out, c.want, c.label);
        if (c.anti !== undefined) assert.doesNotMatch(out, c.anti, `${c.label} — anti-pattern must be absent`);
    }
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
    const out = PacketWire.renderLog(system.log, tok);
    assert.doesNotMatch(out, /<<EDIT\(/);
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
    assert.match(out, /## Plurnk System Requirements\n\nConclude the loop with <<SEND\[200\]:answer:SEND$/,
        "requirements renders LAST under its own header, nothing after it");
    const reqIdx = out.indexOf("## Plurnk System Requirements");
    assert.ok(reqIdx > out.indexOf("## Plurnk System User Prompt"), "requirements follows the prompt");
    assert.ok(reqIdx > out.indexOf("## Plurnk System Budget"), "requirements follows the budget section");
    assert.ok(reqIdx > out.indexOf("## Plurnk System Errors"), "requirements follows the errors section");
});

test("[§requirements-requirements-omitted-when-empty] empty requirements section emits no header", () => {
    const out = PacketWire.renderSlot([
        { name: "prompt", slot: "user", header: "Plurnk System User Prompt", content: "P", tokens: 0 },
        { name: "requirements", slot: "user", header: "Plurnk System Requirements", content: "", tokens: 0 },
    ], "user");
    assert.doesNotMatch(out, /## Plurnk System Requirements/, "no requirements section when the content is empty");
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
    }], tok);
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
    const out = PacketWire.renderLog(system.log, tok);
    assert.match(out, /<<:::\/page\.html\n<h1>Hi<\/h1>\n:::\/page\.html/);
    assert.doesNotMatch(out, /1:\t/);
});

test("[§model-entry] a folded model row renders meta-only — the verbatim hides until OPEN", () => {
    const out = PacketWire.renderLog([{
        coordinate: "1/1/1", origin: "model", op: "model", status: 200, folded: true,
        rx: { content: "<<PLAN:Initialize:PLAN\n<<SEND[102]:Initialized:SEND", mimetype: "text/vnd.plurnk" },
    }], tok);
    assert.match(out, /^- \{"op":"model"/, "folded → '-' marker, meta line only");
    assert.doesNotMatch(out, /Initialize/, "the verbatim body stays hidden while folded — budget-neutral");
});

test("[§model-entry] an open model row mirrors the model's own emission back, line-numbered", () => {
    const out = PacketWire.renderLog([{
        coordinate: "1/1/1", origin: "model", op: "model", status: 200, folded: false,
        rx: { content: "<<PLAN:Initialize:PLAN\n<<SEND[102]:Initialized:SEND", mimetype: "text/vnd.plurnk" },
    }], tok);
    assert.match(out, /^\+ \{"op":"model"/, "open → '+' marker");
    assert.match(out, /1:\t<<PLAN:Initialize:PLAN/, "the model sees its own emission — line 1");
    assert.match(out, /2:\t<<SEND\[102\]:Initialized:SEND/, "line 2, referenceable when reasoning through a syntax error");
});
