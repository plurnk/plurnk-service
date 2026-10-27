import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { renderJsonResult } from "./index.ts";
import { formatJsonDocument } from "./JsonDocument.ts";
import { addressOf, withoutBodies } from "./LogRow.ts";

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
test("{§acp-plurnk-metadata} withoutBodies strips body-bearing attributes and preserves metadata", () => {
    assert.deepEqual(
        withoutBodies({
            kind: "edit",
            original: "before",
            patched: "after",
            patchedBytes: 5,
            patch: "@@ -1 +1 @@",
            editReceipt: { lines: 1 },
            body: "content",
            inputBody: "stdin",
            exitCode: 0,
        }),
        { kind: "edit", exitCode: 0 },
    );
});

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
});
