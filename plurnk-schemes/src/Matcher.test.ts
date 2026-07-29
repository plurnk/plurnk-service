// Unit tests for Matcher.ts adapter. The actual dialect dispatch lives
// in @plurnk/plurnk-mimetypes; what we test here is the error-to-status
// mapping, coordinate preservation, and the 204/200/203 result construction.

import test from "node:test";
import { strict as assert } from "node:assert";
import type { MatcherBody } from "@plurnk/plurnk-grammar";
import type { Mimetypes, QueryMatch, ParsedBodyMatcher } from "@plurnk/plurnk-mimetypes";
import {
    UnsupportedDialectError,
    InvalidExpressionError,
    QueryParseFailureError,
} from "@plurnk/plurnk-mimetypes";
import Matcher from "./Matcher.ts";

// Stub factory: returns a Mimetypes-shaped object whose `query` resolves
// or rejects per the caller's spec. The adapter only touches `query`.
const stubMimetypes = (impl: (input: object, matcher: string | ParsedBodyMatcher) => Promise<QueryMatch[]>): Mimetypes => {
    return {
        query: async (input: object, matcher: string | ParsedBodyMatcher) => {
            const matches = await impl(input, matcher);
            return matches.map((match) => match.lines === undefined || match.rows !== undefined
                ? match
                : {
                    ...match,
                    rows: match.lines.map(({ line, endLine }) => ({ row: line, endRow: endLine })),
                });
        },
    } as unknown as Mimetypes;
};

const regexBody: MatcherBody = { dialect: "regex", raw: "/foo/", pattern: "foo", flags: "" };

// A content-backed hit's footprint: one span anchored at line N (start === end
// for a single-line hit). Matches the mimetypes #41 QueryMatch.lines shape.
const at = (n: number) => [{ line: n, endLine: n }];

// Source fixture the matcher reads line text from. The matcher SELECTS a line;
// READ returns that line's CONTENT, not the matched token (schemes#27).
const doc = [
    "# Title",          // 1
    "alpha foo beta",   // 2 — one hit
    "gamma",            // 3
    "delta foo foo",    // 4 — two hits on one line (dedup)
].join("\n");

test("matcher: returns deduped source/readable coordinates", async () => {
    const mts = stubMimetypes(async () => [
        { lines: at(2), matched: "foo" },
        { lines: at(4), matched: "foo" },
        { lines: at(4), matched: "foo" },
    ]);
    const r = await Matcher.matchAgainstContent(regexBody, doc, "text/markdown", mts);
    assert.equal(r.status, 200);
    assert.deepEqual(r.matches, [
        { lineStart: 2, lineEnd: 2, rowStart: 2, rowEnd: 2 },
        { lineStart: 4, lineEnd: 4, rowStart: 4, rowEnd: 4 },
    ]);
    assert.equal(r.body, undefined);
});

test("matcher: a multi-line span remains one range", async () => {
    const mts = stubMimetypes(async () => [{ lines: [{ line: 2, endLine: 4 }], matched: "block" }]);
    const r = await Matcher.matchAgainstContent(regexBody, doc, "text/markdown", mts);
    assert.deepEqual(r.matches, [{
        lineStart: 2,
        lineEnd: 4,
        rowStart: 2,
        rowEnd: 4,
    }]);
});

test("matcher: passes the PARSED matcher to query (no re-parse), declared dialect authoritative (mimetypes#42)", async () => {
    let seen: string | ParsedBodyMatcher | undefined;
    const mts = stubMimetypes(async (_input, matcher) => { seen = matcher; return []; });
    // A regex body whose pattern `@foo` would STRING-classify as graph — the
    // exact drift #42 kills. We pass {dialect:"regex"} so it runs as regex.
    const body: MatcherBody = { dialect: "regex", raw: "/@foo/g", pattern: "@foo", flags: "g" };
    await Matcher.matchAgainstContent(body, "irrelevant", "text/markdown", mts);
    assert.deepEqual(seen, { dialect: "regex", pattern: "@foo", flags: "g" });
});

test("matcher: a structural dialect passes {dialect, pattern: raw} (no flags)", async () => {
    let seen: string | ParsedBodyMatcher | undefined;
    const mts = stubMimetypes(async (_input, matcher) => { seen = matcher; return []; });
    await Matcher.matchAgainstContent(
        { dialect: "jsonpath", raw: "$.users[*].name" } as MatcherBody,
        "irrelevant", "application/json", mts,
    );
    assert.deepEqual(seen, { dialect: "jsonpath", pattern: "$.users[*].name" });
});

test("matcher: a footprint-less match selects without faked coordinates", async () => {
    const mts = stubMimetypes(async () => [{ matched: 42 }]);
    const r = await Matcher.matchAgainstContent(
        { dialect: "xpath", raw: "count(//item)" } as MatcherBody,
        "irrelevant", "text/html", mts,
    );
    assert.equal(r.status, 200);
    assert.deepEqual(r.matches, []);
    assert.equal(r.body, undefined);
});

test("matcher: framework returns empty array → status 204", async () => {
    const mts = stubMimetypes(async () => []);
    const r = await Matcher.matchAgainstContent(regexBody, doc, "text/markdown", mts);
    assert.equal(r.status, 204);
    assert.deepEqual(r.matches, []);
    assert.equal(r.body, undefined);
});

test("matcher: structural hit exposes its canonical path as metadata", async () => {
    const json = ['{', '  "users": [', '    { "name": "Alice" },', '    { "name": "Bob" }', '  ]', '}'].join("\n");
    const mts = stubMimetypes(async () => [
        { lines: at(3), matched: "Alice", matching: "$.users[0].name" },
        { lines: at(4), matched: "Bob", matching: "$.users[1].name" },
    ]);
    const r = await Matcher.matchAgainstContent(
        { dialect: "jsonpath", raw: "$.users[*].name" } as MatcherBody,
        json, "application/json", mts,
    );
    assert.deepEqual(r.matches, [
        { lineStart: 3, lineEnd: 3, rowStart: 3, rowEnd: 3, path: "$.users[0].name" },
        { lineStart: 4, lineEnd: 4, rowStart: 4, rowEnd: 4, path: "$.users[1].name" },
    ]);
});

test("matcher: footprint-less values do not become retrieval content", async () => {
    const mts = stubMimetypes(async () => [
        { matched: { name: "Alice", role: "admin" } },
        { matched: "two\nlines" },
    ]);
    const r = await Matcher.matchAgainstContent(
        { dialect: "xpath", raw: "(//*)[string()]" } as MatcherBody,
        "irrelevant", "text/html", mts,
    );
    assert.deepEqual(r.matches, []);
    assert.equal(r.body, undefined);
});

test("matcher: UnsupportedDialectError → 415", async () => {
    const mts = stubMimetypes(async () => {
        throw new UnsupportedDialectError({
            mimetype: "image/png", dialect: "regex", reason: "binary content",
        });
    });
    const r = await Matcher.matchAgainstContent(regexBody, "x", "image/png", mts);
    assert.equal(r.status, 415);
    assert.ok((r.problem?.detail ?? "").length > 0);
});

test("matcher: InvalidExpressionError → 400", async () => {
    const mts = stubMimetypes(async () => {
        throw new InvalidExpressionError({
            dialect: "regex", expression: "/[/", cause: new Error("unclosed bracket"),
        });
    });
    const r = await Matcher.matchAgainstContent(regexBody, "x", "text/markdown", mts);
    assert.equal(r.status, 400);
});

test("matcher: QueryParseFailureError → 203 fallback with raw content + reason", async () => {
    const mts = stubMimetypes(async () => {
        throw new QueryParseFailureError({
            mimetype: "application/json", cause: new SyntaxError("unexpected token } in JSON"),
        });
    });
    const r = await Matcher.matchAgainstContent(
        { dialect: "jsonpath", raw: "$.field" } as MatcherBody,
        "{broken json", "application/json", mts,
    );
    assert.equal(r.status, 203);
    assert.equal(r.body, "{broken json");  // raw content preserved
    assert.equal(r.mimetype, "text/markdown");
    assert.ok((r.reason ?? "").length > 0);
});

test("matcher: unexpected error propagates (not caught)", async () => {
    const mts = stubMimetypes(async () => {
        throw new Error("something else entirely");
    });
    await assert.rejects(
        Matcher.matchAgainstContent(regexBody, "x", "text/markdown", mts),
        /something else entirely/,
    );
});

// Integration guard: the xpath dialect is served by @plurnk/plurnk-mimetypes
// (>=0.14.0, queryXpathString wired into Mimetypes.query) — NOT by a local
// xml engine. This pins that schemes serves xpath through the framework with
// zero runtime deps (resolves plurnk-service's de-dup ask, schemes#14). Uses
// a real Mimetypes instance, not a stub, so a regression in the dep surfaces.
test("matcher: xpath dialect served by the framework, no local xml engine", async () => {
    const { Mimetypes } = await import("@plurnk/plurnk-mimetypes");
    const mts = new Mimetypes({ defaultMimetype: "text/markdown" });
    const xpathBody: MatcherBody = { dialect: "xpath", raw: "//item" };
    const xml = "<root>\n  <item>a</item>\n  <item>b</item>\n</root>";
    const r = await Matcher.matchAgainstContent(xpathBody, xml, "text/html", mts);
    assert.equal(r.status, 200);
    assert.deepEqual(r.matches, [
        { lineStart: 2, lineEnd: 2, rowStart: 2, rowEnd: 2, path: "(//item)[1]" },
        { lineStart: 3, lineEnd: 3, rowStart: 3, rowEnd: 3, path: "(//item)[2]" },
    ]);
});
