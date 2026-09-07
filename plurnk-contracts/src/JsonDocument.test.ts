import test from "node:test";
import assert from "node:assert/strict";
import { formatJsonDocument } from "./JsonDocument.ts";

test("JSON presentation changes only whitespace outside literal tokens", () => {
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
    assert.equal(formatJsonDocument(rendered!), rendered, "formatting is idempotent");
});

test("JSON presentation declines malformed documents and stream framing", () => {
    for (const source of ["", "plain text", '{"partial":', '{"trailing":1,}', '{/* comment */"x":1}', '{"a":1}\n{"b":2}']) {
        assert.equal(formatJsonDocument(source), undefined, source);
    }
    for (const source of ["0", "false", "null", '"a  b"', "[]", "{}"]) {
        assert.equal(formatJsonDocument(source), source);
    }
});
