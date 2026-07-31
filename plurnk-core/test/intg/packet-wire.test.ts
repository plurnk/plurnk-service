import test from "node:test";
import assert from "node:assert/strict";
import PacketWire from "../../src/core/packet-wire.ts";

// These render tests assert on bodies/substrings, never on token VALUES — any
// deterministic tokenizer satisfies renderLog's signature (tokens land on the
// body-bearing meta lines, measured by this fn).
const tok = (s: string): number => Math.ceil(s.length / 4);
const revision = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
const receipt = (context: string, requested = "<2>") => ({
    revision,
    unit: "lines",
    before: 4,
    after: 5,
    effect: {
        requested,
        source: "2",
        result: "2-3",
        removed: 1,
        inserted: 2,
        context,
    },
});

// Default-channel convention: when a channel's name matches its scheme's
// defaultChannel, the heredoc fence is path-only (no `#channel` suffix).
// The absence of a suffix IS the addressing of the default channel.

test("log entry: a no-body row renders explicit display:none and body:\"\" — path is log URI, target is action operand", () => {
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
    assert.match(out, /\{"body":"","display":"none","op":"EDIT","origin":"model","path":"log:\/\/\/1\/1\/1\/EDIT","status":200,"target":"out\.txt","tokens":0\}/, "jsonplurnk object; display:none carries body:\"\"; path = log URI identity; target = action operand; tokens:0");
});

test("a folded-authority web URL renders https://host/... — never https:///host (#370 class, run42 sweep)", () => {
    const out = PacketWire.renderLog([{
        coordinate: "1/1/9", origin: "model", op: "EDIT", status: 200,
        target: { scheme: "https", pathname: "/en.wikipedia.org/wiki/Paris" },
        rx: { status: 200 },
    }], tok);
    assert.match(out, /"target":"https:\/\/en\.wikipedia\.org\/wiki\/Paris"/, "the authority form, one spelling");
});

test("COPY/MOVE render ordered resource effects and only textual regional receipts", () => {
    const out = PacketWire.renderLog([{
        coordinate: "1/2/5",
        origin: "model",
        op: "COPY",
        status: 200,
        target: { scheme: "worker", pathname: "/source" },
        rx: {
            status: 200,
            effects: [{
                target: "worker:///draft",
                action: "update",
                receipt: receipt("1:before\n2:copied content"),
            }],
        },
    }], tok);
    assert.match(
        out,
        /"effects":\[\{"target":"worker:\/\/\/draft","action":"update","rev":"abcdef01","extent":"lines 4->5","change":"-1 \+2","range":"<2> 2->2-3"\}\]/,
    );
    assert.match(
        out,
        /<<:::log:\/\/\/1\/2\/5\/COPY\n1:before\n2:copied content\n:::log:\/\/\/1\/2\/5\/COPY/,
        "the regional effect exposes its bounded resulting context",
    );

    const whole = PacketWire.renderLog([{
        coordinate: "1/2/6",
        origin: "model",
        op: "MOVE",
        status: 200,
        target: { scheme: "worker", pathname: "/source" },
        rx: {
            status: 200,
            effects: [
                { target: "worker:///destination", action: "create" },
                { target: "worker:///source", action: "delete" },
            ],
        },
    }], tok);
    assert.match(
        whole,
        /"effects":\[\{"target":"worker:\/\/\/destination","action":"create"\},\{"target":"worker:\/\/\/source","action":"delete"\}\]/,
    );
    assert.match(whole, /"body":"","display":"none"/, "whole-channel effects invent no text receipt");
});

test("EDIT with an accept-path span (rx.body from a proposed file edit) renders the line-numbered diff", () => {
    // A PROPOSED file EDIT's accept delivers its editedSpan under rx.body (the generic accept-rx key),
    // where the inline entry-scheme EDIT delivers the same span under rx.span. Both must render — the
    // model has to SEE what its write changed in the EDIT row itself, or it re-EDITs the file across
    // turns (the observed 0-token bodyless-EDIT gap). §edit-result-render.
    const out = PacketWire.renderLog([{
        coordinate: "1/4/2",
        origin: "model",
        op: "EDIT",
        status: 200,
        target: { scheme: null, pathname: "/src/app.js" },
        rx: { status: 200, body: "3:app.listen(8080);\n4:// error handler configured" },
    }], tok);
    assert.match(out, /<<:::src\/app\.js\n3:app\.listen\(8080\);\n4:\/\/ error handler configured\n:::src\/app\.js/, "the proposed file EDIT's accept-path span renders as the line-numbered diff — parity with the inline rx.span");
});

test("log entry: a worker:// spawn renders the worker NAME in the target — authority survives ()", () => {
    // The spawn-blindness root cause: the worker name lives in the URI authority (worker://<name>),
    // not the path. Rendering scheme+path alone collapsed every spawn to a bare `worker://`, so the
    // model could not tell worker_db from worker_pool in its own log and re-spawned. The authority
    // must reach the rendered target.
    const out = PacketWire.renderLog([
        { coordinate: "1/1/9", origin: "model", op: "EDIT", status: 200, target: { scheme: "worker", hostname: "worker_db", pathname: "" } },
        { coordinate: "1/1/10", origin: "model", op: "EDIT", status: 200, target: { scheme: "worker", hostname: "worker_pool", pathname: "" } },
    ], tok);
    assert.match(out, /"target":"worker:\/\/worker_db"/, "the spawned worker name reaches the model's log");
    assert.match(out, /"target":"worker:\/\/worker_pool"/, "distinct workers render distinctly — no bare worker://");
    assert.doesNotMatch(out, /"target":"worker:\/\/"/, "no nameless worker:// rows (the blindness)");
});

test("log entry: a web host survives into the target — http://host/path, not http:///path", () => {
    // Same render path, same bug class: an authority-bearing scheme keeps its host in `hostname`.
    const out = PacketWire.renderLog([
        { coordinate: "1/1/1", origin: "model", op: "READ", status: 200, target: { scheme: "https", hostname: "en.wikipedia.org", pathname: "/wiki/Paris" } },
    ], tok);
    assert.match(out, /"target":"https:\/\/en\.wikipedia\.org\/wiki\/Paris"/, "the web host reaches the rendered target");
});

test("log render: READ@200 with text/markdown rx body → line-numbered heredoc", () => {
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
    // Line-navigable mimetype → `N:` prefix per line.
    assert.match(out, /<<:::notes\.md\n1:hello\n2:world\n:::notes\.md/);
});

test("log render: a scoped READ preserves its complete source TextRegion", () => {
    const out = PacketWire.renderLog([{
        coordinate: "1/1/3",
        origin: "model",
        op: "READ",
        status: 200,
        target: { scheme: "worker", pathname: "/unicode" },
        rx: {
            status: 200,
            content: "😀",
            mimetype: "text/markdown",
            startLine: 1,
            region: {
                startLine: 1,
                startColumn: 2,
                endLine: 1,
                endColumn: 3,
            },
        },
    }], tok);
    assert.match(
        out,
        /"region":\{"startLine":1,"startColumn":2,"endLine":1,"endColumn":3\}/,
    );
    assert.match(out, /\n1:😀\n/);
});

test("a failed content-bearing READ renders both its Problem and diagnostic body", () => {
    const out = PacketWire.renderLog([{
        coordinate: "1/2/1",
        origin: "plurnk",
        op: "READ",
        status: 500,
        target: { scheme: "sh", pathname: "/1/1/2", fragment: "stderr" },
        rx: {
            status: 500,
            problem: {
                type: "https://problems.plurnk.dev/executor/subprocess/nonzero-exit",
                title: "Nonzero exit",
                status: 500,
                detail: "'sh' exited with code 1.",
                stage: "execution",
                recovery: "Inspect stderr and correct the command.",
                retryable: false,
                exitCode: 1,
            },
            content: "main.go:17: undefined: os",
            mimetype: "text/stream",
            startLine: 1,
        },
        folded: false,
    }], tok);

    assert.match(out, /"problem":\{[^}]*"detail":"'sh' exited with code 1\."/);
    assert.match(out, /"recovery":"Inspect stderr and correct the command\."/);
    assert.match(out, /"exitCode":1/, "structured producer facts survive packet materialization");
    assert.doesNotMatch(out, /"error":/, "the packet does not flatten Problem Details into a legacy error string");
    assert.match(out, /"status":500/);
    assert.match(out, /"display":"open"/);
    assert.match(out, /1:main\.go:17: undefined: os/, "failure status never erases diagnostic content");
});

test("log render: a matcher READ keeps the resource body and exposes surgical coordinates", () => {
    const matches = [
        { region: { startLine: 143, startColumn: 1, endLine: 143, endColumn: 8 } },
        { region: { startLine: 617, startColumn: 4, endLine: 617, endColumn: 11 } },
    ];
    const out = PacketWire.renderLog([{
        coordinate: "1/1/3",
        origin: "model",
        op: "READ",
        status: 200,
        target: { scheme: null, pathname: "/spec.md" },
        tx: { body: { raw: "/grinder/" } },
        rx: {
            content: "intro\ngrinder\ncontext",
            mimetype: "text/markdown",
            startLine: 1,
            matches,
        },
    }], tok);
    assert.match(out, /"matcher":"\/grinder\/"/);
    assert.match(out, /"matches":\[\{"region":\{"startLine":143,"startColumn":1,"endLine":143,"endColumn":8\}\},\{"region":\{"startLine":617,"startColumn":4,"endLine":617,"endColumn":11\}\}\]/);
    assert.match(out, /<<:::spec\.md\n1:intro\n2:grinder\n3:context\n:::spec\.md/);
});

test("log render: malformed matcher evidence cannot reach the model packet", () => {
    assert.throws(() => PacketWire.renderLog([{
        coordinate: "1/1/3",
        origin: "model",
        op: "READ",
        status: 200,
        target: { scheme: null, pathname: "/spec.md" },
        rx: {
            content: "text",
            mimetype: "text/markdown",
            matches: [{ path: "" }],
        },
    }], tok), /path must be a non-empty string/);
});

test("log render: READ@200 with application/json is line-addressable", () => {
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
    assert.match(out, /<<:::notes\.md\n1:\[\n2: {2}\{"line":1,"matched":"hello"\}\n3:\]\n:::notes\.md/);
});

// EDIT log renders re-emit the model's statement as heredoc — same syntax
// the model would write to cause this state. No udiff in the model's
// packet (that format belongs in client communication, where humans want
// colored before/after rendering).

test("log render: EDIT@200 with rx.span → wraps the pre-numbered span verbatim (editedSpan owns the offsets)", () => {
    const out = PacketWire.renderLog([{
        coordinate: "1/1/2",
        origin: "model",
        op: "EDIT",
        status: 200,
        target: { scheme: "worker", pathname: "/plan.md" },
        rx: { status: 200, span: "3:- [x] ship the fix" },  // editedSpan emits N: with the changed region's REAL offset
    }], tok);
    // The model sees the edited area as it looks NOW at its TRUE line numbers — editedSpan already
    // line-numbered it, so the renderer wraps verbatim. Re-numbering here would double it (1:3:…)
    // and lose the real position. (A span-less EDIT — a scheme that returns no span — stands on its meta
    // line alone; the log NEVER re-serializes the op's emission tag, per the no-tags-in-the-log paradigm.)
    assert.match(out, /<<:::worker:\/\/\/plan\.md\n3:- \[x\] ship the fix\n:::worker:\/\/\/plan\.md/, "EDIT wraps the pre-numbered span verbatim under the target fence");
    assert.doesNotMatch(out, /1:3:/, "must NOT re-number an already-numbered span");
});

test("log render: model EDIT receipt renders revision and bounded join context verbatim", () => {
    const exactReceipt = receipt("1:one\n2:TWO\n3:2.5\n4:three");
    const out = PacketWire.renderLog([{
        coordinate: "1/1/3",
        origin: "model",
        op: "EDIT", status: 200,
        target: { scheme: "worker", pathname: "/draft" },
        rx: { status: 200, receipt: exactReceipt },
    }], tok);
    assert.match(out, /"rev":"abcdef01"/);
    assert.match(out, /"extent":"lines 4->5"/);
    assert.match(out, /"change":"-1 \+2"/);
    assert.match(out, /"range":"<2> 2->2-3"/);
    assert.match(out, /3:2\.5/);
    assert.doesNotMatch(out, new RegExp(revision));
});

test("render guard: every content-emitting op applies the N: convention uniformly", () => {
    // The model orients on line numbers, so EVERY op that emits a content body
    // must number textual content regardless of mimetype. Pins the invariant
    // across READ, FIND, EDIT-span,
    // EXEC-body, the foisted exec-stream delta (incl. its cross-turn startLine), and PLAN/SEND bodies —
    // which ride into the log as N: content, NEVER re-serialized as a <<OP:…:OP tag (the log mirrors
    // the model's WORK, not its emission syntax). No future content branch can silently diverge.
    const base = { coordinate: "1/1/1", origin: "model", status: 200, target: { scheme: "worker", pathname: "/a" } };
    const execTx = (body: string) => ({ op: "EXEC", suffix: "sh", target: { kind: "url", raw: "sh:///1/1/1", scheme: "sh", pathname: "/1/1/1", fragment: null }, body, signal: null, lineMarker: null });
    const cases: Array<{ label: string; entry: unknown; want: RegExp; anti?: RegExp }> = [
        { label: "READ text → numbered", entry: { ...base, op: "READ", rx: { status: 200, mimetype: "text/markdown", content: "alpha\nbeta" } }, want: /1:alpha\n2:beta/ },
        { label: "READ json -> numbered", entry: { ...base, op: "READ", rx: { status: 200, mimetype: "application/json", content: '{"k":1}' } }, want: /\n1:\{"k":1\}\n/ },
        { label: "READ mixed newlines -> every physical line numbered", entry: { ...base, op: "READ", rx: { status: 200, mimetype: "text/plain", content: "a\r\nb\rc" } }, want: /1:a\r\n2:b\r3:c/ },
        { label: "FIND text → numbered", entry: { ...base, op: "FIND", rx: { status: 200, mimetype: "text/markdown", content: "m1\nm2" } }, want: /1:m1\n2:m2/ },
        { label: "EDIT span → pre-numbered span preserved verbatim (editedSpan owns the real offsets)", entry: { ...base, op: "EDIT", rx: { status: 200, span: "5:x\n6:y" } }, want: /5:x\n6:y/, anti: /1:5:/ },
        { label: "EXEC body → numbered", entry: { ...base, op: "EXEC", target: { scheme: "sh", pathname: "/1/1/1" }, tx: execTx("ls\npwd") }, want: /1:ls\n2:pwd/ },
        { label: "exec-stream delta → cross-turn startLine continues", entry: { ...base, op: "READ", origin: "plurnk", target: { scheme: "sh", pathname: "/1/1/1", fragment: "stdout" }, rx: { status: 200, mimetype: "text/stream", content: "out5\nout6", startLine: 5 } }, want: /5:out5\n6:out6/ },
        { label: "PLAN body → numbered content, never a <<PLAN tag", entry: { ...base, op: "PLAN", tx: { body: "read line 2\nthen answer" } }, want: /1:read line 2\n2:then answer/, anti: /<<PLAN/ },
        { label: "SEND body → numbered content, never a <<SEND tag", entry: { ...base, op: "SEND", tx: { body: "here is the answer" } }, want: /1:here is the answer/, anti: /<<SEND/ },
    ];
    for (const c of cases) {
        const out = PacketWire.renderLog([c.entry], tok);
        assert.match(out, c.want, c.label);
        if (c.anti !== undefined) assert.doesNotMatch(out, c.anti, `${c.label} — anti-pattern must be absent`);
    }
});

test("an oversized auto-opened terminal stream uses the universal log-body preview", () => {
    const output = Array.from({ length: 40 }, (_, i) => `stream line ${i + 1}`).join("\n");
    const rendered = PacketWire.renderLog([{
        coordinate: "1/2/1",
        origin: "plurnk",
        op: "READ",
        status: 200,
        target: { scheme: "sh", pathname: "/1/1/1", fragment: "stdout" },
        rx: { status: 200, mimetype: "text/stream", content: output, startLine: 1 },
        folded: false,
    }], tok);
    assert.match(rendered, /1:stream line 1/, "the terminal output arrives OPEN");
    assert.doesNotMatch(rendered, /stream line 30/, "the pushed tail cannot bypass the arrival bound");
    assert.match(
        rendered,
        /"overflow":"Body content truncated\. Use READ log:\/\/\/1\/2\/1\/READ to view the full body\."/,
        "the cut points at the canonical complete log body",
    );
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
            target: { scheme: "worker", pathname: "/x" },
            rx: { status: 200, entryId: 5, channel: "body" },
        }],
    };
    const out = PacketWire.renderLog(system.log, tok);
    assert.doesNotMatch(out, /<<EDIT\(/);
});

test("notice render: message and content-offset share one bounded line, no snippet fence", () => {
    const notices = [{
        source: "provider:test",
        kind: "grammar_unenforced",
        level: "warn",
        message: "output diverged from the grammar",
        position: { type: "content-offset", line: 1, column: 0 },
    }];
    const out = PacketWire.renderNotices(notices);
    assert.match(out, /^\* grammar_unenforced: output diverged from the grammar @ 1:0$/m);
    assert.doesNotMatch(out, /\{"/, "no JSON dump");
    assert.doesNotMatch(out, /error:\/\//, "no snippet fence");
});

test("a durable failure pointer renders as a terse <status> log:/// link, no JSON", () => {
    const out = PacketWire.renderFailurePointers([{ status: 403, coordinate: "1/1/2/EDIT" }]);
    assert.match(out, /^\* 403 log:\/\/\/1\/1\/2\/EDIT$/m);
    assert.doesNotMatch(out, /\{"/, "no JSON dump — the row holds the detail, the section a link");
});

test("heterogeneous failures render as uniform durable pointers, no per-kind shape", () => {
    // A dispatch refusal (400), an action failure (403), a budget overflow (413): three categories, one
    // channel. Each is a LogCoordinate-positioned event rendered as the same terse link — the section
    // never restates the term or carries per-kind JSON. The detail lives on each row, READ via the link.
    const errors = [
        { status: 400, coordinate: "1/2/3/error" },
        { status: 403, coordinate: "1/2/5/EDIT" },
        { status: 413, coordinate: "1/3/1/error" },
    ];
    const out = PacketWire.renderFailurePointers(errors);
    assert.equal(out, "* 400 log:///1/2/3/error\n* 403 log:///1/2/5/EDIT\n* 413 log:///1/3/1/error");
    assert.doesNotMatch(out, /\{"/, "no JSON — every category is the same terse link");
});

test("requirements renders LAST in the user slot, under its own header", () => {
    // The default packet orders the user slot prompt → budget → errors → … →
    // requirements; renderSlot preserves that order, so requirements lands last.
    const out = PacketWire.renderSlot([
        { name: "prompt", slot: "user", header: "Plurnk Service Active User Prompts", content: "Reply with just the number.", tokens: 0 },
        { name: "budget", slot: "user", header: "Plurnk Service Budget", content: "5000 free", tokens: 0 },
        { name: "errors", slot: "user", header: "Plurnk Service Errors", content: PacketWire.renderFailurePointers([{ status: 409, coordinate: "1/1/1/error" }]), tokens: 0 },
        { name: "requirements", slot: "user", header: "Plurnk Service Requirements", content: "Conclude the loop with <<SEND[200]:answer:SEND", tokens: 0 },
    ], "user");
    // §requirements: requirements is the contract that must win conflicts with the
    // natural-language prompt, so it renders closest to the assistant turn —
    // after the prompt, budget, and errors, with nothing following it.
    assert.match(out, /## Plurnk Service Requirements\n\nConclude the loop with <<SEND\[200\]:answer:SEND$/,
        "requirements renders LAST under its own header, nothing after it");
    const reqIdx = out.indexOf("## Plurnk Service Requirements");
    assert.ok(reqIdx > out.indexOf("## Plurnk Service Active User Prompts"), "requirements follows the prompt");
    assert.ok(reqIdx > out.indexOf("## Plurnk Service Budget"), "requirements follows the budget section");
    assert.ok(reqIdx > out.indexOf("## Plurnk Service Errors"), "requirements follows the errors section");
});

test("empty requirements section emits no header", () => {
    const out = PacketWire.renderSlot([
        { name: "prompt", slot: "user", header: "Plurnk Service Active User Prompts", content: "P", tokens: 0 },
        { name: "requirements", slot: "user", header: "Plurnk Service Requirements", content: "", tokens: 0 },
    ], "user");
    assert.doesNotMatch(out, /## Plurnk Service Requirements/, "no requirements section when the content is empty");
});

test("log render: FIND@200 renders its result catalog, not just the echoed query", () => {
    // The turn-0 foisted FIND catalog map is how a worker's opening catalog reaches
    // the packet. If the renderer only re-emits the query statement (the regression),
    // the model is shown its own question and zero entries.
    const catalog = '[\n  {\n    "path": "prompt:///1/1",\n    "channels": {\n      "prompt:///1/1": { "mimetype": "text/markdown", "tokens": 20, "lines": 1 }\n    }\n  }\n]';
    const out = PacketWire.renderLog([{
        coordinate: "1/1/2",
        origin: "plurnk",
        op: "FIND",
        status: 200,
        target: { scheme: "plurnk", pathname: "" },
        tx: { op: "FIND", suffix: "", target: { kind: "url", raw: "plurnk:///**", scheme: "plurnk", pathname: "", fragment: null }, body: null, signal: null, lineMarker: null },
        rx: { content: catalog, mimetype: "application/json" },
    }], tok);
    assert.match(out, /"path": "prompt:\/\/\/1\/1"/, "FIND@200 renders its result body - the model sees what the FIND returned");
    assert.match(out, /\n1:\[/);
});

test("log render: READ@200 with text/html is line-addressable", () => {
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
    assert.match(out, /<<:::page\.html\n1:<h1>Hi<\/h1>\n:::page\.html/);
});

test("a folded model row renders meta-only — the verbatim hides until OPEN", () => {
    const out = PacketWire.renderLog([{
        coordinate: "1/1/1", origin: "model", op: "model", status: 200, folded: true,
        rx: { content: "<<PLAN:Initialize:PLAN\n<<SEND[102]:Initialized:SEND", mimetype: "text/vnd.plurnk" },
    }], tok);
    assert.match(out, /\{"display":"folded","lines":2,"op":"model"/, "folded → display:folded, meta only — lines counts the navigable body");
    assert.doesNotMatch(out, /Initialize/, "the verbatim body stays hidden while folded — budget-neutral");
});

test("an open model row mirrors the model's own emission back, line-numbered", () => {
    const out = PacketWire.renderLog([{
        coordinate: "1/1/1", origin: "model", op: "model", status: 200, folded: false,
        rx: { content: "<<PLAN:Initialize:PLAN\n<<SEND[102]:Initialized:SEND", mimetype: "text/vnd.plurnk" },
    }], tok);
    assert.match(out, /\{"display":"open","lines":2,"op":"model"/, "open → display:open — lines counts the navigable body");
    assert.match(out, /1:<<PLAN:Initialize:PLAN/, "the model sees its own emission — line 1");
    assert.match(out, /2:<<SEND\[102\]:Initialized:SEND/, "line 2, referenceable when reasoning through a syntax error");
});

test("the Log renders as a fenced jsonplurnk array that strips to valid JSON — one carve-out, deterministically", () => {
    const out = PacketWire.renderLog([
        { coordinate: "1/1/1", origin: "model", op: "FIND", status: 200, target: { scheme: "worker", pathname: "" }, rx: { content: "[]", mimetype: "application/json" } }, // none: empty FIND, no body
        { coordinate: "1/1/2", origin: "model", op: "READ", status: 200, folded: true, target: { scheme: null, pathname: "/a.md" }, rx: { content: "alpha\nbeta", mimetype: "text/markdown", startLine: 1 } }, // folded: body hidden
        { coordinate: "1/1/3", origin: "model", op: "READ", status: 200, folded: false, target: { scheme: null, pathname: "/b.md" }, rx: { content: "gamma", mimetype: "text/markdown", startLine: 1 } }, // open: heredoc body
    ], tok);
    assert.match(out, /^`{3,}jsonplurnk\n/, "the fence leads — the Log carries data only, no prose note");
    const m = /(`{3,})jsonplurnk\n([\s\S]*?)\n\1/.exec(out);
    assert.ok(m, "a fenced jsonplurnk block");
    // Strip the ONE deviation (a `body` heredoc) with a content-agnostic, TAG-anchored transform → strict JSON.
    const strict = m![2].replace(/"body":\n<<:::(.+)\n[\s\S]*?\n:::\1\n\}/g, '"body":""}');
    const arr = JSON.parse(strict) as Array<{ display: string; body?: string }>;
    assert.deepEqual(arr.map((e) => e.display), ["none", "folded", "open"], "the three display states render explicitly — no glyph legend");
    assert.equal(arr[0].body, "", "display:none carries an explicit empty JSON body");
    assert.ok(!("body" in arr[1]), "display:folded withholds its body");
    assert.equal(arr[2].body, "", "the open row's heredoc body — the one deviation — strips to a string, recovering valid JSON");
});

test("the opening fence outgrows any backtick run a body carries — a code sample can't close the block", () => {
    // A body whose own text opens a triple-backtick fence (a READ of a doc with a code sample). The
    // jsonplurnk opener must be LONGER, so the body can never close the block early.
    const out = PacketWire.renderLog([{
        coordinate: "1/1/1", origin: "model", op: "READ", status: 200,
        target: { scheme: null, pathname: "/doc.md" },
        rx: { content: "```js\nx();\n```", mimetype: "text/markdown", startLine: 1 },
    }], tok);
    const opener = /(`{3,})jsonplurnk/.exec(out)?.[1] ?? "";
    assert.ok(opener.length >= 4, `fence opens with ${opener.length} backticks — longer than the body's 3-run, so the body cannot close it`);
});

test("only worker-issued READ/FIND bodies bypass the universal preview", () => {
    const long = Array.from({ length: 30 }, (_, i) => `line ${i + 1} of a runaway emission`).join("\n");

    // A short PLAN renders whole — no behavior change for a well-formed op.
    const shortOut = PacketWire.renderLog([
        { coordinate: "1/1/1", origin: "model", op: "PLAN", status: 200, target: { scheme: null, pathname: "" }, tx: { body: "Tidy context, then read the loader." } },
    ], tok);
    assert.match(shortOut, /Tidy context, then read the loader\./, "a short PLAN renders in full");
    assert.doesNotMatch(shortOut, /"overflow"/, "no overflow under the bound");

    // A runaway PLAN (30 lines) renders preview-bounded — the run42 bomb, defused.
    const planOut = PacketWire.renderLog([
        { coordinate: "1/1/1", origin: "model", op: "PLAN", status: 200, target: { scheme: null, pathname: "" }, tx: { body: long } },
    ], tok);
    assert.match(planOut, /"overflow":"Body content truncated\. Use READ log:\/\/\/1\/1\/1\/PLAN to view the full body\."/, "the PLAN preview is recoverable");
    assert.doesNotMatch(planOut, /line 20 of a runaway/, "content past the 16-line preview is cut from the render");

    // Mutation receipts are generated results, not deliberate retrievals.
    const numberedSpan = Array.from({ length: 30 }, (_, i) => `${i + 1}:span line ${i + 1}`).join("\n");
    const editOut = PacketWire.renderLog([
        { coordinate: "1/1/2", origin: "model", op: "EDIT", status: 200, target: { scheme: "worker", pathname: "/x" }, rx: { span: numberedSpan } },
    ], tok);
    assert.doesNotMatch(editOut, /span line 30/, "an EDIT receipt cannot bypass the preview");
    assert.match(editOut, /"overflow":"Body content truncated\. Use READ log:\/\/\/1\/1\/2\/EDIT to view the full body\."/, "the complete receipt remains retrievable");

    // READ and FIND deliver RETRIEVED content — full, even when long (the exemption).
    const readOut = PacketWire.renderLog([
        { coordinate: "1/1/3", origin: "model", op: "READ", status: 200, target: { scheme: null, pathname: "/big.txt" }, rx: { content: long, mimetype: "text/plain", startLine: 1 } },
    ], tok);
    assert.match(readOut, /line 30 of a runaway/, "a long READ delivers full content — retrieval is exempt");
    assert.doesNotMatch(readOut, /"overflow"/, "no preview cut on a worker-issued READ");

    const findOut = PacketWire.renderLog([
        { coordinate: "1/1/4", origin: "model", op: "FIND", status: 200, target: { scheme: null, pathname: "" }, rx: { content: long, mimetype: "text/plain", startLine: null } },
    ], tok);
    assert.match(findOut, /line 30 of a runaway/, "a long FIND renders its full result — retrieval is exempt");
    assert.doesNotMatch(findOut, /"overflow"/, "no preview cut on a worker-issued FIND");

    const pushedRead = PacketWire.renderLog([
        { coordinate: "1/1/5", origin: "plurnk", op: "READ", status: 200, target: { scheme: "sh", pathname: "/1/1/1" }, rx: { content: long, mimetype: "text/plain", startLine: 1 } },
    ], tok);
    assert.doesNotMatch(pushedRead, /line 30 of a runaway/, "a READ-shaped engine push is still previewed");
    assert.match(pushedRead, /"overflow":"Body content truncated\. Use READ log:\/\/\/1\/1\/5\/READ to view the full body\."/, "provenance, not the overloaded op label, controls the exemption");
});

test("every non-retrieval body producer uses the same recoverable preview", () => {
    const long = Array.from({ length: 30 }, (_, i) => `producer line ${i + 1}`).join("\n");
    const numbered = Array.from({ length: 30 }, (_, i) => `${i + 1}:producer line ${i + 1}`).join("\n");
    const entries = [
        { op: "prompt", origin: "plurnk", target: { scheme: "prompt", pathname: "/1/1" }, rx: { content: long, mimetype: "text/markdown" } },
        { op: "model", origin: "model", target: null, rx: { content: long, mimetype: "text/vnd.plurnk" } },
        { op: "PLAN", origin: "model", target: null, tx: { body: long } },
        { op: "SEND", origin: "model", target: null, tx: { body: { raw: long } } },
        { op: "WORK", origin: "model", target: { scheme: "worker", pathname: "/reviewer" }, tx: { body: long } },
        { op: "FORK", origin: "model", target: null, tx: { body: long } },
        { op: "EXEC", origin: "model", target: { scheme: "sh", pathname: "/1/1/1" }, tx: { body: long } },
        { op: "EDIT", origin: "model", target: { scheme: "worker", pathname: "/a" }, rx: { span: numbered } },
        { op: "COPY", origin: "model", target: { scheme: "worker", pathname: "/b" }, rx: { effects: [{ target: "worker:///b", action: "update", receipt: receipt(numbered) }] } },
        { op: "MOVE", origin: "model", target: { scheme: "worker", pathname: "/c" }, rx: { effects: [{ target: "worker:///c", action: "update", receipt: receipt(numbered) }] } },
        { op: "READ", origin: "plurnk", target: { scheme: "sh", pathname: "/1/1/1" }, rx: { content: long, mimetype: "text/plain" } },
        { op: "FIND", origin: "plurnk", target: { scheme: "worker", pathname: "/**" }, rx: { content: long, mimetype: "text/plain" } },
        { op: "extension", origin: "plugin", target: { scheme: "custom", pathname: "/result" }, rx: { content: long, mimetype: "text/plain" } },
    ];

    entries.forEach((entry, index) => {
        const coordinate = `1/2/${index + 1}`;
        const rendered = PacketWire.renderLog([{ coordinate, status: 200, ...entry }], tok);
        assert.doesNotMatch(rendered, /producer line 30/, `${entry.op} cannot bypass the preview`);
        assert.ok(
            rendered.includes(`"overflow":"Body content truncated. Use READ log:///${coordinate}/${entry.op} to view the full body."`),
            `${entry.op} exposes the same log recovery contract`,
        );
    });
});

test("preview bounds are exact and reject invalid configuration", () => {
    const previousLines = process.env.PLURNK_SERVICE_PREVIEW_LINES;
    const previousChars = process.env.PLURNK_SERVICE_PREVIEW_CHARS;
    try {
        process.env.PLURNK_SERVICE_PREVIEW_LINES = "16";
        process.env.PLURNK_SERVICE_PREVIEW_CHARS = "10000";
        const sixteenTerminatedLines = `${Array.from({ length: 16 }, (_, i) => `line ${i + 1}`).join("\n")}\n`;
        const exact = PacketWire.renderLog([{
            coordinate: "1/1/1",
            origin: "plurnk",
            op: "prompt",
            status: 200,
            target: { scheme: "prompt", pathname: "/1/1" },
            rx: { content: sixteenTerminatedLines, mimetype: "text/plain" },
        }], tok);
        assert.doesNotMatch(exact, /"overflow"/, "a trailing newline does not invent a seventeenth line");

        process.env.PLURNK_SERVICE_PREVIEW_LINES = "0";
        assert.throws(
            () => PacketWire.renderLog([{ coordinate: "1/1/1", op: "PLAN", origin: "model", status: 200, tx: { body: "x" } }], tok),
            /PLURNK_SERVICE_PREVIEW_LINES must be a positive safe integer/,
        );
        process.env.PLURNK_SERVICE_PREVIEW_LINES = "16";
        process.env.PLURNK_SERVICE_PREVIEW_CHARS = "NaN";
        assert.throws(
            () => PacketWire.renderLog([{ coordinate: "1/1/1", op: "PLAN", origin: "model", status: 200, tx: { body: "x" } }], tok),
            /PLURNK_SERVICE_PREVIEW_CHARS must be a positive safe integer/,
        );
    } finally {
        if (previousLines === undefined) delete process.env.PLURNK_SERVICE_PREVIEW_LINES;
        else process.env.PLURNK_SERVICE_PREVIEW_LINES = previousLines;
        if (previousChars === undefined) delete process.env.PLURNK_SERVICE_PREVIEW_CHARS;
        else process.env.PLURNK_SERVICE_PREVIEW_CHARS = previousChars;
    }
});
