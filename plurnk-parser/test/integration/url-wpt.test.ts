// {§path-syntax}, {§path-query}, {§path-parentheses}.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PathSyntax, PlurnkParseError } from "@plurnk/plurnk-contracts";
import { parsePath, PlurnkParser } from "../../src/index.ts";

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
const category = ({ input }: UrlCase) => !/^[a-z][a-z0-9+.-]*:\/\//iu.test(input)
    ? "local"
    : /[\r\n<]/u.test(input) ? "outside-heading" : "uri";

test("the pinned WPT corpus accounts for every target category", () => {
    assert.equal(cases.length, 893);
    assert.equal(cases.filter((item) => category(item) === "local").length, 344);
    assert.equal(cases.filter((item) => category(item) === "outside-heading").length, 21);
    assert.equal(cases.filter((item) => category(item) === "uri").length, 528);
    assert.equal(cases.filter((item) => category(item) === "uri" && item.failure).length, 239);
    assert.equal(cases.filter((item) => idnaVariances.has(item.input)).length, 8);
});

for (const [index, item] of cases.entries()) {
    test(`WPT URL ${index}: ${JSON.stringify(item.input)}`, {
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
