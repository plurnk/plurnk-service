// Unit tests for Matcher.ts adapter. The actual dialect dispatch lives
// in @plurnk/plurnk-mimetypes; what we test here is the error→status
// mapping, the baseLine offset, and the 204/200/203 result construction.

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
    return { query: impl } as unknown as Mimetypes;
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

test("matcher: returns the SOURCE LINE at each hit (not the value), deduped by line", async () => {
    // Three regex hits — lines 2, 4, 4. Output is the source LINES, line 4 once.
    const mts = stubMimetypes(async () => [
        { lines: at(2), matched: "foo" },
        { lines: at(4), matched: "foo" },
        { lines: at(4), matched: "foo" },
    ]);
    const r = await Matcher.matchAgainstContent(regexBody, doc, "text/markdown", mts);
    assert.equal(r.status, 200);
    assert.equal(r.matches, 2); // deduped line count, not raw hit count
    assert.equal(r.body, "2:\talpha foo beta\n4:\tdelta foo foo");
    assert.equal((r.body ?? "").includes("\tfoo"), false); // the token is never the rendered value
});

test("matcher: a multi-line span anchors on — and renders — its start line", async () => {
    const mts = stubMimetypes(async () => [{ lines: [{ line: 2, endLine: 4 }], matched: "block" }]);
    const r = await Matcher.matchAgainstContent(regexBody, doc, "text/markdown", mts);
    assert.equal(r.body, "2:\talpha foo beta");
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

test("matcher: a footprint-less match (xpath computed scalar) renders bare — no faked line", async () => {
    const mts = stubMimetypes(async () => [{ matched: 42 }]); // count(//item) — lives nowhere in source
    const r = await Matcher.matchAgainstContent(
        { dialect: "xpath", raw: "count(//item)" } as MatcherBody,
        "irrelevant", "text/html", mts,
    );
    assert.equal(r.status, 200);
    assert.equal(r.matches, 1);
    assert.equal(r.body, "42");
});

test("matcher: framework returns empty array → status 204", async () => {
    const mts = stubMimetypes(async () => []);
    const r = await Matcher.matchAgainstContent(regexBody, doc, "text/markdown", mts);
    assert.equal(r.status, 204);
    assert.equal(r.matches, 0);
    assert.equal(r.body, undefined);
});

test("matcher: baseLine displays SOURCE line numbers while reading text from the slice", async () => {
    // The matcher ran against a slice; the framework reports slice lines 1 and 3.
    const slice = ["foo here", "x", "and foo too"].join("\n");
    const mts = stubMimetypes(async () => [
        { lines: at(1), matched: "foo" },
        { lines: at(3), matched: "foo" },
    ]);
    // Slice began at source line 10 → display 10 and 12, text from the slice.
    const r = await Matcher.matchAgainstContent(regexBody, slice, "text/markdown", mts, 10);
    assert.equal(r.status, 200);
    assert.equal(r.body, "10:\tfoo here\n12:\tand foo too");
});

test("matcher: baseLine=1 (no slice) reports lines verbatim", async () => {
    const mts = stubMimetypes(async () => [{ lines: at(2), matched: "foo" }]);
    const r = await Matcher.matchAgainstContent(regexBody, doc, "text/markdown", mts, 1);
    assert.equal(r.body, "2:\talpha foo beta");
});

test("matcher: structural hit renders its source line, `matching` path never surfaced (schemes#12/#27)", async () => {
    const json = ['{', '  "users": [', '    { "name": "Alice" },', '    { "name": "Bob" }', '  ]', '}'].join("\n");
    const mts = stubMimetypes(async () => [
        { lines: at(3), matched: "Alice", matching: "$.users[0].name" },
        { lines: at(4), matched: "Bob", matching: "$.users[1].name" },
    ]);
    const r = await Matcher.matchAgainstContent(
        { dialect: "jsonpath", raw: "$.users[*].name" } as MatcherBody,
        json, "application/json", mts,
    );
    // The source line is returned (it contains the value, in context); the
    // resolved path is never rendered.
    assert.equal(r.body, '3:\t    { "name": "Alice" },\n4:\t    { "name": "Bob" }');
    assert.equal((r.body ?? "").includes("$.users"), false);
});

test("matcher: a footprint-less object/multi-line value is JSON-encoded to one line", async () => {
    const mts = stubMimetypes(async () => [
        { matched: { name: "Alice", role: "admin" } },
        { matched: "two\nlines" },
    ]);
    const r = await Matcher.matchAgainstContent(
        { dialect: "xpath", raw: "(//*)[string()]" } as MatcherBody,
        "irrelevant", "text/html", mts,
    );
    assert.equal(r.body, `{"name":"Alice","role":"admin"}\n"two\\nlines"`);
    assert.equal((r.body ?? "").split("\n").length, 2); // one entry per match
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
    assert.equal(r.matches, 2);
    // End-to-end proof that structural dialects SELF-PROVIDE source lines
    // (mimetypes #41) and we render the SOURCE LINE, not the node value (#27):
    // each hit is `<n>:\t  <item>…</item>`, the whole source line — never bare `a`/`b`.
    assert.match(r.body ?? "", /^\d+:\t {2}<item>a<\/item>$/m);
    assert.match(r.body ?? "", /^\d+:\t {2}<item>b<\/item>$/m);
});
