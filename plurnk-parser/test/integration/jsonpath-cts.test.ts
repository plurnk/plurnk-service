// {§matcher-prefix-claims}, {§pattern-body-single-line}, {§error-shape}.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSONPathEnvironment, JSONPathError } from "json-p3";
import { PlurnkParser } from "../../src/index.ts";

const corpus = JSON.parse(await readFile(new URL("../fixtures/jsonpath-cts/cts.json", import.meta.url), "utf8")) as {
    tests: { name: string; selector: string; invalid_selector?: boolean }[];
};
const engine = new JSONPathEnvironment();

test("the pinned JSONPath corpus covers every admission and framing category", () => {
    const cases = corpus.tests;
    assert.equal(cases.length, 706);
    assert.equal(cases.filter((item) => !item.invalid_selector).length, 459);
    assert.equal(cases.filter((item) => item.invalid_selector).length, 247);
    assert.equal(cases.filter((item) => /[\r\n]/u.test(item.selector)).length, 87);
    assert.equal(cases.filter((item) => /[\r\n]/u.test(item.selector) && !item.invalid_selector).length, 76);
    assert.equal(cases.filter((item) => !item.selector.startsWith("$")).length, 1);
});

for (const item of corpus.tests) {
    test(`JSONPath CTS: ${item.name}`, () => {
        if (item.invalid_selector) assert.throws(() => engine.compile(item.selector), JSONPathError);
        else assert.doesNotThrow(() => engine.compile(item.selector));

        const source = PlurnkParser.frame(`READ (data.json) [${JSON.stringify({ pattern: item.selector })}]`, null);
        const parsed = PlurnkParser.parseStatements(source);
        assert.equal(parsed.unparsedTail, undefined);
        const statements = parsed.items.flatMap((entry) => entry.kind === "statement" ? [entry.statement] : []);
        const errors = parsed.items.flatMap((entry) => entry.kind === "error" ? [entry.error] : []);
        if (/[\r\n]/u.test(item.selector) || item.invalid_selector && item.selector.startsWith("$")) {
            assert.deepEqual(statements, []);
            assert.equal(errors.length, 1);
            const [error] = errors;
            assert.equal(error.severity, "error");
            assert.equal(error.source, "visitor");
            assert.equal(error.line, 1);
            assert.equal(error.column, 0);
            assert.match(error.message, /[\r\n]/u.test(item.selector)
                ? /^Matcher has \d+ lines; expected 1\.$/u
                : /^pattern leads with `\$` but is not a valid jsonpath/u);
            return;
        }
        assert.deepEqual(errors, []);
        assert.equal(statements.length, 1);
        const [statement] = statements;
        assert.equal(statement.op, "READ");
        assert.ok("matcher" in statement);
        assert.deepEqual(statement.matcher, {
            dialect: item.selector.startsWith("$") ? "jsonpath" : "glob",
            raw: item.selector,
        });
    });
}
