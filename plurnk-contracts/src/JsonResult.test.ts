import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { renderJsonResult, requestOrigin } from "./index.ts";
import { formatJsonDocument } from "./JsonDocument.ts";
import { addressOf, toolKindOf } from "./LogRow.ts";
import { excerptOf } from "./Excerpt.ts";
import { lifecycleOfLoopStatus, selectSessionLoop } from "./LoopLifecycle.ts";

describe("JsonResult", () => {
test("{§contract-representations} renderJsonResult gives each top-level array item one physical line", () => {
    const value = [
        { title: "one, nested", values: [1, 2] },
        { title: "two", nested: { comma: ",", line: "a\nb" } },
        "three, literal",
    ];
    const rendered = renderJsonResult(value);

    assert.equal(
        rendered,
        '[{"title":"one, nested","values":[1,2]},\n{"title":"two","nested":{"comma":",","line":"a\\nb"}},\n"three, literal"]',
    );
    assert.deepEqual(JSON.parse(rendered), value, "presentation remains one valid JSON value");
});

test("{§contract-representations} renderJsonResult leaves non-array JSON compact and rejects no-value output", () => {
    assert.equal(renderJsonResult({ ok: true, nested: [1, 2] }), '{"ok":true,"nested":[1,2]}');
    assert.equal(renderJsonResult([]), "[]");
    assert.equal(renderJsonResult([1]), "[1]");
    assert.throws(() => renderJsonResult(undefined), /must serialize to a JSON value/);
});

test("{§contract-representations} renderJsonResult preserves JSON.stringify replacer behavior", () => {
    const rendered = renderJsonResult(
        [{ value: 1n }, { value: 2n }],
        (_key, value) => typeof value === "bigint" ? value.toString() : value,
    );
    assert.equal(rendered, '[{"value":"1"},\n{"value":"2"}]');
});
});

describe("JsonDocument", () => {
test("{§contract-representations} JSON presentation changes only whitespace outside literal tokens", () => {
    const source = '{"id":9007199254740993,"n":1e+09,"n":-0,"text":"a\\n  b \\u0061","items":[true,null,{}]}';
    const rendered = formatJsonDocument(source);
    assert.equal(rendered, [
        "{",
        '  "id": 9007199254740993,',
        '  "n": 1e+09,',
        '  "n": -0,',
        '  "text": "a\\n  b \\u0061",',
        '  "items": [',
        "    true,",
        "    null,",
        "    {}",
        "  ]",
        "}",
    ].join("\n"));
    assert.equal(formatJsonDocument(rendered), rendered, "formatting is idempotent");
});

test("{§contract-representations} JSON presentation declines malformed documents and stream framing", () => {
    for (const source of ["", "plain text", '{"partial":', '{"trailing":1,}', '{/* comment */"x":1}', '{"a":1}\n{"b":2}']) {
        assert.equal(formatJsonDocument(source), undefined, source);
    }
    for (const source of ["0", "false", "null", '"a  b"', "[]", "{}"]) {
        assert.equal(formatJsonDocument(source), source);
    }
});
});

describe("LogRow", () => {
test("{§acp-plurnk-metadata} addressOf formats scheme URIs, file paths, and null when absent", () => {
    assert.equal(
        addressOf({ scheme: "https", hostname: "example.com", port: 8443, pathname: "/a", query: "b=1", fragment: "top" }),
        "https://example.com:8443/a?b=1#top",
    );
    assert.equal(addressOf({ scheme: "workspace", hostname: null, pathname: "/plan.md" }), "workspace:///plan.md");
    assert.equal(addressOf({ scheme: "ops", hostname: "helper", pathname: "/1" }), "ops://helper/1");
    assert.equal(addressOf({ scheme: null, pathname: "src/a.ts", fragment: "stderr" }), "src/a.ts#stderr");
    assert.equal(addressOf({ scheme: null, pathname: null }), null);
});

test("{§acp-plurnk-metadata} {§capability-policy-cascade} toolKindOf maps verbs and schemes to canonical tool-call kinds", () => {
    assert.equal(toolKindOf("READ", "file"), "read");
    assert.equal(toolKindOf("READ", "http"), "fetch");
    assert.equal(toolKindOf("READ", "https"), "fetch");
    assert.equal(toolKindOf("EDIT", "file"), "edit");
    assert.equal(toolKindOf("COPY", "file"), "edit");
    assert.equal(toolKindOf("MOVE", "file"), "move");
    assert.equal(toolKindOf("KILL", "file"), "delete");
    assert.equal(toolKindOf("FIND", "workspace"), "search");
    assert.equal(toolKindOf("NOTE", null), "think");
    assert.equal(toolKindOf("WAIT", null), "think");
    assert.equal(toolKindOf("SEND", null), "other");
    assert.equal(toolKindOf("WORK", null), "execute");
    assert.equal(toolKindOf("FORK", null), "execute");
    assert.equal(toolKindOf("sh", "sh"), "execute");
    assert.equal(toolKindOf(null, null), "other");
});
});

describe("Excerpt", () => {
test("{§application-session-observation} the excerpt is the first line holding anything but blanks, cut whole characters, blanks trimmed from its end", () => {
    const cases: ReadonlyArray<readonly [string, number, string, boolean, string]> = [
        ["Fits.", 10, "Fits.", false, "a short message is its own excerpt"],
        ["Fits.\n   \n", 10, "Fits.", false, "trailing blank lines continue nothing"],
        ["\n \n  No, you did it wrong!  \r\nHere is why.", 10, "No, you di", true, "leading blank lines and spaces are skipped"],
        ["Check the tests, all of them.", 10, "Check the", true, "a cut that lands after a space keeps no trailing blank"],
        ["Line one\r\nLine two", 20, "Line one", true, "a carriage return ends no excerpt's words"],
        ["a\tb", 10, "a\tb", false, "a tab inside the line stays"],
        ["😀".repeat(12), 10, "😀".repeat(10), true, "a character is never cut in two"],
        ["", 10, "", false, "an empty message"],
        [" \n\t\r\n", 10, "", false, "a message of blanks alone"],
        [" x", 10, " x", false, "a no-break space is not a blank"],
        ["first\n\nsecond", 3, "fir", true, "a cut first line continues"],
    ];
    for (const [text, chars, excerpt, continued, why] of cases) {
        assert.deepEqual(excerptOf(text, chars), { excerpt, continued }, why);
    }
    const long = `${"x".repeat(1_000_000)}\nmore`;
    assert.deepEqual(excerptOf(long, 240), { excerpt: "x".repeat(240), continued: true }, "a long line costs its excerpt, not its length");
});
});

describe("HttpOrigin", () => {
test("{§http-host} a request's origin is the address its Host names, over http, else the listener's own", () => {
    const listener = { host: "0.0.0.0", port: 1066 };
    for (const [named, origin] of [
        ["192.168.1.88:1066", "http://192.168.1.88:1066"],
        ["desktop.lan:1066", "http://desktop.lan:1066"],
        ["[fe80::1]:1066", "http://[fe80::1]:1066"],
        ["localhost", "http://localhost"],
    ] as const) assert.equal(requestOrigin({ headers: { host: named } }, listener), origin, named);
    assert.equal(requestOrigin({ headers: {} }, listener), "http://0.0.0.0:1066", "a request that names no address is answered at the listener's");
    assert.equal(requestOrigin({ headers: {} }, { host: "::1", port: 1066 }), "http://[::1]:1066");
});
});

describe("LoopLifecycle", () => {
test("{§application-session-observation} one projection from loop status to the shared lifecycle words", () => {
    assert.equal(lifecycleOfLoopStatus(null), "idle");
    assert.equal(lifecycleOfLoopStatus(undefined), "idle");
    assert.equal(lifecycleOfLoopStatus(100), "queued");
    assert.equal(lifecycleOfLoopStatus(102), "running");
    assert.equal(lifecycleOfLoopStatus(202), "parked");
    for (const concluded of [200, 204]) assert.equal(lifecycleOfLoopStatus(concluded), "completed", `a loop that concluded ${concluded}`);
    assert.equal(lifecycleOfLoopStatus(499), "cancelled", "a loop stopped without failing");
    for (const terminal of [413, 429, 500, 504, 508]) assert.equal(lifecycleOfLoopStatus(terminal), "failed", String(terminal));
});

test("{§application-session-observation}: live work outranks newer terminal history", () => {
    const loop = (sequence: number, status: number, terminatedAt: string | null = null) => ({ sequence, status, terminatedAt });
    const running = loop(2, 102);
    const parked = loop(1, 202);
    const queued = loop(3, 100);
    const completed = loop(4, 200, "2026-09-16T01:00:00.000Z");
    const failed = loop(5, 500, "2026-09-16T00:00:00.000Z");
    assert.equal(selectSessionLoop([parked, running, queued, completed, failed]), running);
    assert.equal(selectSessionLoop([completed, queued, parked]), parked);
    assert.equal(selectSessionLoop([completed, queued]), queued);
    assert.equal(selectSessionLoop([failed, completed]), completed, "latest settlement, not greatest sequence");
    assert.equal(selectSessionLoop([loop(6, 100), queued]), queued, "oldest obligation within the same live state");
    assert.equal(selectSessionLoop([]), null);
});
});
