import test from "node:test";
import assert from "node:assert/strict";
import { renderJsonResult } from "./index.ts";

test("renderJsonResult gives each top-level array item one physical line", () => {
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

test("renderJsonResult leaves non-array JSON compact and rejects no-value output", () => {
    assert.equal(renderJsonResult({ ok: true, nested: [1, 2] }), '{"ok":true,"nested":[1,2]}');
    assert.equal(renderJsonResult([]), "[]");
    assert.equal(renderJsonResult([1]), "[1]");
    assert.throws(() => renderJsonResult(undefined), /must serialize to a JSON value/);
});

test("renderJsonResult preserves JSON.stringify replacer behavior", () => {
    const rendered = renderJsonResult(
        [{ value: 1n }, { value: 2n }],
        (_key, value) => typeof value === "bigint" ? value.toString() : value,
    );
    assert.equal(rendered, '[{"value":"1"},\n{"value":"2"}]');
});
