// Unit tests for matcher.ts. Dialect dispatch, projection, AND source-line
// provenance all live in @plurnk/plurnk-mimetypes, reached through the single
// high-level Mimetypes.query(input, ParsedBodyMatcher) (mimetypes#42). What
// plurnk-service owns the orchestration around that call: building the parsed
// matcher, preserving source/readable coordinates, and mapping statuses.

import test from "node:test";
import { strict as assert } from "node:assert";
import type { MatcherBody } from "@plurnk/plurnk-grammar";
import type { Mimetypes, QueryMatch, ParsedBodyMatcher } from "@plurnk/plurnk-mimetypes";
import { InvalidExpressionError, QueryParseFailureError } from "@plurnk/plurnk-mimetypes";
import Matcher from "./matcher.ts";
import MimetypeBinary from "./mimetype-binary.ts";

// Stub the one plugin method matcher.ts invokes. The impl receives
// (input, matcher) and returns (or throws) what the plugin would.
const stubQuery = (impl: (input: { content: string; hint: string }, matcher: ParsedBodyMatcher) => Promise<QueryMatch[]>): Mimetypes =>
    ({ query: impl } as unknown as Mimetypes);

// A single-line hit: source line N (1-based) carrying matched value v.
const hit = (line: number, matched: unknown): QueryMatch =>
    ({
        matched,
        matching: `#${line}`,
        lines: [{ line, endLine: line }],
        rows: [{ row: line, endRow: line }],
    });

const regexBody = (pattern: string): MatcherBody => ({ dialect: "regex", raw: `/${pattern}/`, pattern, flags: "" });

test("regex hits select the resource and retain source/readable coordinates", async () => {
    const content = "alpha\nfoo bar\nbeta\nfoo baz";
    const r = await Matcher.matchAgainstContent(regexBody("foo"), content, "text/markdown",
        stubQuery(async () => [hit(2, "foo"), hit(4, "foo")]));
    assert.equal(r.status, 200);
    assert.deepEqual(r.matches, [
        { lineStart: 2, lineEnd: 2, rowStart: 2, rowEnd: 2, path: "#2" },
        { lineStart: 4, lineEnd: 4, rowStart: 4, rowEnd: 4, path: "#4" },
    ]);
    assert.equal(r.body, undefined);
});

test("matcher applied with zero hits → 204, no body", async () => {
    const r = await Matcher.matchAgainstContent(regexBody("zzz"), "alpha\nbeta", "text/markdown",
        stubQuery(async () => []));
    assert.equal(r.status, 204);
    assert.deepEqual(r.matches, []);
    assert.equal(r.body, undefined);
});

test("structural hits expose coordinates rather than extracted values", async () => {
    // jsonpath $.users[*] over multi-line JSON: each object resolves to the line it sits on.
    const content = '{\n  "users": [\n    { "name": "Alice", "role": "admin" },\n    { "name": "Bob" }\n  ]\n}';
    const r = await Matcher.matchAgainstContent(
        { dialect: "jsonpath", raw: "$.users[*]" } as MatcherBody, content, "application/json",
        stubQuery(async () => [hit(3, { name: "Alice", role: "admin" }), hit(4, { name: "Bob" })]));
    assert.equal(r.status, 200);
    assert.deepEqual(r.matches, [
        { lineStart: 3, lineEnd: 3, rowStart: 3, rowEnd: 3, path: "#3" },
        { lineStart: 4, lineEnd: 4, rowStart: 4, rowEnd: 4, path: "#4" },
    ]);
});

test("two structural matches on one line retain distinct canonical paths", async () => {
    const r = await Matcher.matchAgainstContent(
        { dialect: "jsonpath", raw: "$.users[*].name" } as MatcherBody,
        '{"users":[{"name":"Alice"},{"name":"Bob"}]}', "application/json",
        stubQuery(async () => [
            { ...hit(1, "Alice"), matching: "$.users[0].name" },
            { ...hit(1, "Bob"), matching: "$.users[1].name" },
        ]));
    assert.equal(r.status, 200);
    assert.deepEqual(r.matches, [
        { lineStart: 1, lineEnd: 1, rowStart: 1, rowEnd: 1, path: "$.users[0].name" },
        { lineStart: 1, lineEnd: 1, rowStart: 1, rowEnd: 1, path: "$.users[1].name" },
    ]);
});

test("a multi-line match remains one coordinate range", async () => {
    const content = "<root>\n  <user>\n    Alice\n  </user>\n</root>";
    const r = await Matcher.matchAgainstContent(
        { dialect: "xpath", raw: "//user" } as MatcherBody, content, "text/html",
        stubQuery(async () => [{
            matched: "<user>...</user>",
            matching: "(//user)[1]",
            lines: [{ line: 2, endLine: 4 }],
            rows: [{ row: 2, endRow: 4 }],
        }]));
    assert.equal(r.status, 200);
    assert.deepEqual(r.matches, [{
        lineStart: 2,
        lineEnd: 4,
        rowStart: 2,
        rowEnd: 4,
        path: "(//user)[1]",
    }]);
});

test("a source-less scalar selects the resource without fabricated coordinates", async () => {
    const r = await Matcher.matchAgainstContent(
        { dialect: "xpath", raw: "count(//user)" } as MatcherBody, "<root><user/><user/></root>", "text/html",
        stubQuery(async () => [{ matched: 2 }]));
    assert.equal(r.status, 200);
    assert.deepEqual(r.matches, []);
});

test("source unparseable for its mimetype → 203 soft fallback with raw content + reason", async () => {
    const r = await Matcher.matchAgainstContent(
        { dialect: "jsonpath", raw: "$.field" } as MatcherBody, "{broken json", "application/json",
        stubQuery(async () => { throw new QueryParseFailureError({ mimetype: "application/json", cause: new Error("unexpected token } in JSON") }); }));
    assert.equal(r.status, 203);
    assert.equal(r.body, "{broken json");  // raw bytes handed back so the model can regex/visual-parse
    assert.equal(r.mimetype, MimetypeBinary.TEXT_PRIMITIVE_MIMETYPE);
    assert.ok((r.reason ?? "").includes("Failed to parse content for query"));  // plugin's templated reason
});

test("malformed matcher expression → 400 (model-facing, not a 500)", async () => {
    const r = await Matcher.matchAgainstContent(
        { dialect: "xpath", raw: "//[" } as MatcherBody, "<root><a/></root>", "text/html",
        stubQuery(async () => { throw new InvalidExpressionError({ dialect: "xpath", expression: "//[" }); }));
    assert.equal(r.status, 400);
    assert.equal(r.problem?.type, "https://problems.plurnk.dev/schemes/matcher/invalid-expression");
    assert.equal(r.problem?.stage, "matcher");
    assert.equal(r.problem?.dialect, "xpath");
    assert.equal(r.problem?.recovery, "Correct or remove the matcher.");
    assert.equal(r.problem?.retryable, false);
});

test("relation dialects (~semantic / @graph) never reach the content matcher — they resolve through FIND (#286)", async () => {
    // Invariant: both relation dialects resolve through the persistent search index to
    // (resource, span) items; neither is a content matcher. Reaching matchAgainstContent with one is a
    // routing bug → fail hard, not a silent 501/400.
    const stub = stubQuery(async () => { throw new Error("query must not be called for a relation dialect"); });
    await assert.rejects(Matcher.matchAgainstContent({ dialect: "semantic", raw: "~query" } as MatcherBody, "x", "text/markdown", stub), /content-only/);
    await assert.rejects(Matcher.matchAgainstContent({ dialect: "graph", raw: "@graph" } as MatcherBody, "x", "text/markdown", stub), /content-only/);
});
