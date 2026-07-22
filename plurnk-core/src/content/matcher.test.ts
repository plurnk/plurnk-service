// Unit tests for matcher.ts. Dialect dispatch, projection, AND source-line
// provenance all live in @plurnk/plurnk-mimetypes, reached through the single
// high-level Mimetypes.query(input, ParsedBodyMatcher) (mimetypes#42). What
// plurnk-service OWNS — and this file tests — is the orchestration around that
// call: building the ParsedBodyMatcher from the grammar's MatcherBody, #renderRows
// (each hit's span → `N:<source line>`, deduped, baseLine-shifted — plurnk.md:31/:32),
// and the status mapping (200/204/203/400/501). query is stubbed: we hand it the
// QueryMatch[] the daughter would return and assert how matcher.ts renders it.

import test from "node:test";
import { strict as assert } from "node:assert";
import type { MatcherBody } from "@plurnk/plurnk-grammar";
import type { Mimetypes, QueryMatch, ParsedBodyMatcher } from "@plurnk/plurnk-mimetypes";
import { InvalidExpressionError, QueryParseFailureError } from "@plurnk/plurnk-mimetypes";
import Matcher from "./matcher.ts";
import MimetypeBinary from "./mimetype-binary.ts";

// Stub the one daughter method matcher.ts invokes. The impl receives
// (input, matcher) and returns (or throws) what the daughter would.
const stubQuery = (impl: (input: { content: string; hint: string }, matcher: ParsedBodyMatcher) => Promise<QueryMatch[]>): Mimetypes =>
    ({ query: impl } as unknown as Mimetypes);

// A single-line hit: source line N (1-based) carrying matched value v.
const hit = (line: number, matched: unknown): QueryMatch =>
    ({ matched, matching: `#${line}`, lines: [{ line, endLine: line }] } as unknown as QueryMatch);

const regexBody = (pattern: string): MatcherBody => ({ dialect: "regex", raw: `/${pattern}/`, pattern, flags: "" });

test("regex hits → 200, the SOURCE LINE at each match (not the matched token)", async () => {
    const content = "alpha\nfoo bar\nbeta\nfoo baz";
    const r = await Matcher.matchAgainstContent(regexBody("foo"), content, "text/markdown",
        stubQuery(async () => [hit(2, "foo"), hit(4, "foo")]));
    assert.equal(r.status, 200);
    assert.equal(r.matches, 2);
    assert.equal(r.body, "2:foo bar\n4:foo baz");  // READ delivers the line, not "foo"
    assert.deepEqual(r.lines, [2, 4]);
});

test("matcher applied with zero hits → 204, no body", async () => {
    const r = await Matcher.matchAgainstContent(regexBody("zzz"), "alpha\nbeta", "text/markdown",
        stubQuery(async () => []));
    assert.equal(r.status, 204);
    assert.equal(r.matches, 0);
    assert.equal(r.body, undefined);
});

test("structural hits return the SOURCE LINE — the projected value is never re-encoded", async () => {
    // jsonpath $.users[*] over multi-line JSON: each object resolves to the line it sits on.
    const content = '{\n  "users": [\n    { "name": "Alice", "role": "admin" },\n    { "name": "Bob" }\n  ]\n}';
    const r = await Matcher.matchAgainstContent(
        { dialect: "jsonpath", raw: "$.users[*]" } as MatcherBody, content, "application/json",
        stubQuery(async () => [hit(3, { name: "Alice", role: "admin" }), hit(4, { name: "Bob" })]));
    assert.equal(r.status, 200);
    assert.equal(r.body, '3:    { "name": "Alice", "role": "admin" },\n4:    { "name": "Bob" }');
});

test("two matches on one source line collapse to a single row (dedup by line)", async () => {
    // Single-line JSON: every hit lands on line 1 → one row, not one per match.
    const r = await Matcher.matchAgainstContent(
        { dialect: "jsonpath", raw: "$.users[*].name" } as MatcherBody,
        '{"users":[{"name":"Alice"},{"name":"Bob"}]}', "application/json",
        stubQuery(async () => [hit(1, "Alice"), hit(1, "Bob")]));
    assert.equal(r.status, 200);
    assert.equal(r.matches, 2);
    assert.equal(r.body, '1:{"users":[{"name":"Alice"},{"name":"Bob"}]}');
    assert.deepEqual(r.lines, [1, 1]);  // both hits provenance line 1; render deduped
});

test("a multi-line span emits every line it covers", async () => {
    const content = "<root>\n  <user>\n    Alice\n  </user>\n</root>";
    const r = await Matcher.matchAgainstContent(
        { dialect: "xpath", raw: "//user" } as MatcherBody, content, "text/html",
        stubQuery(async () => [{ matched: "<user>...</user>", matching: "(//user)[1]", lines: [{ line: 2, endLine: 4 }] } as unknown as QueryMatch]));
    assert.equal(r.status, 200);
    assert.equal(r.body, "2:  <user>\n3:    Alice\n4:  </user>");
});

test("a hit with no source span falls back to the matched value (e.g. xpath count())", async () => {
    const r = await Matcher.matchAgainstContent(
        { dialect: "xpath", raw: "count(//user)" } as MatcherBody, "<root><user/><user/></root>", "text/html",
        stubQuery(async () => [{ matched: 2, matching: "count(//user)", lines: [] } as unknown as QueryMatch]));
    assert.equal(r.status, 200);
    assert.equal(r.body, "2");  // computed scalar — no node, no line; render the value itself
    assert.deepEqual(r.lines, []);
});

test("<L> baseLine offset shifts hit lines back into source coordinates", async () => {
    // The matcher saw lines 1-2 of a slice that began at source line 10.
    const r = await Matcher.matchAgainstContent(regexBody("foo"), "foo\nfoo", "text/markdown",
        stubQuery(async () => [hit(1, "foo"), hit(2, "foo")]), 10);
    assert.equal(r.body, "10:foo\n11:foo");
    assert.deepEqual(r.lines, [10, 11]);
});

test("baseLine=1 (no slice) leaves hit lines unshifted", async () => {
    const r = await Matcher.matchAgainstContent(regexBody("foo"), "x\nfoo", "text/markdown",
        stubQuery(async () => [hit(2, "foo")]), 1);
    assert.equal(r.body, "2:foo");
});

test("source unparseable for its mimetype → 203 soft fallback with raw content + reason", async () => {
    const r = await Matcher.matchAgainstContent(
        { dialect: "jsonpath", raw: "$.field" } as MatcherBody, "{broken json", "application/json",
        stubQuery(async () => { throw new QueryParseFailureError({ mimetype: "application/json", cause: new Error("unexpected token } in JSON") }); }));
    assert.equal(r.status, 203);
    assert.equal(r.body, "{broken json");  // raw bytes handed back so the model can regex/visual-parse
    assert.equal(r.mimetype, MimetypeBinary.TEXT_PRIMITIVE_MIMETYPE);
    assert.ok((r.reason ?? "").includes("Failed to parse content for query"));  // daughter's templated reason
});

test("malformed matcher expression → 400 (model-facing, not a 500)", async () => {
    const r = await Matcher.matchAgainstContent(
        { dialect: "xpath", raw: "//[" } as MatcherBody, "<root><a/></root>", "text/html",
        stubQuery(async () => { throw new InvalidExpressionError({ dialect: "xpath", expression: "//[" }); }));
    assert.equal(r.status, 400);
    assert.ok((r.error ?? "").length > 0);
});

test("relation dialects (~semantic / @graph) never reach the content matcher — they resolve through FIND (#286)", async () => {
    // Invariant: ~semantic ranks via rankSemantic and @graph resolves via EntryGraph, each to
    // (file, span) items; neither is a content matcher. Reaching matchAgainstContent with one is a
    // routing bug → fail hard, not a silent 501/400.
    const stub = stubQuery(async () => { throw new Error("query must not be called for a relation dialect"); });
    await assert.rejects(Matcher.matchAgainstContent({ dialect: "semantic", raw: "~query" } as MatcherBody, "x", "text/markdown", stub), /content-only/);
    await assert.rejects(Matcher.matchAgainstContent({ dialect: "graph", raw: "@graph" } as MatcherBody, "x", "text/markdown", stub), /content-only/);
});
