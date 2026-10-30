import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { PlurnkParser, parsePath } from "../../src/index.ts";
import { PathSyntax, PlurnkParseError, Validator } from "@plurnk/plurnk-contracts";
import { readFile } from "node:fs/promises";
import { JSONPathEnvironment, JSONPathError } from "json-p3";

describe("jsonpath-cts", async () => {
const corpus = JSON.parse(await readFile(new URL("../fixtures/jsonpath-cts/cts.json", import.meta.url), "utf8")) as {
    tests: { name: string; selector: string; invalid_selector?: boolean }[];
};
const engine = new JSONPathEnvironment();

test("{§matcher-prefix-claims} the pinned JSONPath corpus covers every admission and framing category", () => {
    const cases = corpus.tests;
    assert.equal(cases.length, 706);
    assert.equal(cases.filter((item) => !item.invalid_selector).length, 459);
    assert.equal(cases.filter((item) => item.invalid_selector).length, 247);
    assert.equal(cases.filter((item) => /[\r\n]/u.test(item.selector)).length, 87);
    assert.equal(cases.filter((item) => /[\r\n]/u.test(item.selector) && !item.invalid_selector).length, 76);
    assert.equal(cases.filter((item) => !item.selector.startsWith("$")).length, 1);
});

const matcherBodySchema = { $ref: "https://schemas.plurnk.xyz/v0/MatcherBody.json" };

for (const item of corpus.tests) {
    test(`{§matcher-prefix-claims} JSONPath CTS: ${item.name}`, () => {
        if (item.invalid_selector) assert.throws(() => engine.compile(item.selector), JSONPathError);
        else assert.doesNotThrow(() => engine.compile(item.selector));

        if (/[\r\n]/u.test(item.selector)) {
            assert.equal(Validator.validateJsonSchemaInstance(matcherBodySchema, { dialect: "jsonpath", raw: item.selector }).valid, false);
            return;
        }
        // Heading-line syntax separates the pattern from preceding slots and EOL by horizontal whitespace.
        if (item.selector !== item.selector.trim()) return;
        const source = PlurnkParser.frame(`READ (data.json) ${item.selector}`, null);
        const parsed = PlurnkParser.parseStatements(source);
        assert.equal(parsed.unparsedTail, undefined);
        const statements = parsed.items.flatMap((entry) => entry.kind === "statement" ? [entry.statement] : []);
        const errors = parsed.items.flatMap((entry) => entry.kind === "error" && entry.error.severity === "error" ? [entry.error] : []);
        if (item.invalid_selector && item.selector.startsWith("$")) {
            // {§matcher-prefix-claims} — the statement is admitted; the matcher carries the refusal and its working form.
            assert.deepEqual(errors, []);
            assert.equal(statements.length, 1);
            const [statement] = statements;
            if (statement.op !== "READ" || statement.matcher?.dialect !== "unreadable") assert.fail(item.name);
            assert.match(statement.matcher.message, /^pattern leads with `\$` but is not a valid jsonpath/u);
            assert.ok(statement.matcher.recovery.length > 0);
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
});

describe("url-wpt", async () => {
type UrlCase = {
    input: string; base: string | null; failure?: boolean;
    href: string; protocol: string; username: string; password: string;
    hostname: string; port: string; pathname: string; search: string; hash: string;
};
const corpus = JSON.parse(await readFile(new URL("../fixtures/wpt-url/urltestdata.json", import.meta.url), "utf8")) as (string | UrlCase)[];
const cases = corpus.filter((item): item is UrlCase => typeof item !== "string");
const idnaVariances = new Set([
    "http://a.b.c.xn--pokxncvks", "http://10.0.0.xn--pokxncvks",
    "http://a.b.c.XN--pokxncvks", "http://a.b.c.Xn--pokxncvks",
    "http://10.0.0.XN--pokxncvks", "http://10.0.0.xN--pokxncvks",
    "file://xn--/p", "https://xn--/",
]);
const category = ({ input }: UrlCase) => !/^[a-z][a-z0-9+._-]*:\/\//iu.test(input)
    ? "local"
    : /[\r\n<]/u.test(input) ? "outside-heading" : "uri";

test("{§path-syntax} the pinned WPT corpus accounts for every target category", () => {
    assert.equal(cases.length, 893);
    assert.equal(cases.filter((item) => category(item) === "local").length, 344);
    assert.equal(cases.filter((item) => category(item) === "outside-heading").length, 21);
    assert.equal(cases.filter((item) => category(item) === "uri").length, 528);
    assert.equal(cases.filter((item) => category(item) === "uri" && item.failure).length, 239);
    assert.equal(cases.filter((item) => idnaVariances.has(item.input)).length, 8);
});

for (const [index, item] of cases.entries()) {
    test(`{§path-syntax} WPT URL ${index}: ${JSON.stringify(item.input)}`, {
        skip: category(item) === "outside-heading" ? "Raw newlines and < are outside the target-slot language." : false,
    }, (t) => {
        const target = PathSyntax.escapeTarget(item.input);
        if (category(item) === "local") {
            const parsed = parsePath(target);
            assert.equal(parsed?.kind ?? null, item.input === "" ? null : "local");
            return;
        }
        let failure = item.failure === true;
        if (idnaVariances.has(item.input) && !URL.canParse(item.input)) {
            t.diagnostic("Known Node URL/IDNA variance: the runtime rejects this WPT-valid hostname.");
            failure = true;
        }
        const heading = PlurnkParser.parseStatements(PlurnkParser.frame(`READ (${target})`, null));
        const statements = heading.items.flatMap((entry) => entry.kind === "statement" ? [entry.statement] : []);
        const errors = heading.items.flatMap((entry) => entry.kind === "error" ? [entry.error] : []);
        assert.equal(heading.unparsedTail, undefined);
        if (failure) {
            assert.throws(() => parsePath(target), (error) => error instanceof PlurnkParseError && error.message === "invalid URI in path");
            assert.deepEqual(statements, []);
            assert.equal(errors.length, 1);
            assert.equal(errors[0].source, "visitor");
            assert.equal(errors[0].message, "invalid URI in path");
            return;
        }
        const expected = {
            kind: "url", raw: item.input,
            scheme: item.protocol.slice(0, -1),
            username: item.username || null, password: item.password || null,
            hostname: item.hostname || null, port: item.port ? Number(item.port) : null,
            pathname: item.input === "http://`{}:`{}@h/`{}?`{}" ? "/%60{}" : item.pathname,
            query: item.href.split("#", 1)[0].includes("?") ? item.search.slice(1) : null,
            fragment: item.hash ? item.hash.slice(1) : null,
        };
        assert.deepEqual(parsePath(target), expected);
        assert.deepEqual(errors, []);
        assert.equal(statements.length, 1);
        assert.equal(statements[0].op, "READ");
        assert.ok("target" in statements[0]);
        assert.deepEqual(statements[0].target, expected);
    });
}
});
