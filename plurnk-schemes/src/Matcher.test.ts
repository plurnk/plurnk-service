// Unit tests for Matcher.ts adapter. The actual dialect dispatch lives
// in @plurnk/plurnk-mimetypes; what we test here is the error-to-status
// mapping, coordinate preservation, and the 204/200/203 result construction.

import test from "node:test";
import { strict as assert } from "node:assert";
import type { MatcherBody } from "@plurnk/plurnk-contracts";
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
        query: async (input: object, matcher: string | ParsedBodyMatcher) =>
            impl(input, matcher),
    } as unknown as Mimetypes;
};

const regexBody: MatcherBody = { dialect: "regex", raw: "/foo/", pattern: "foo", flags: "" };

const at = (line: number, startColumn = 1, endColumn = 2) => [{
    startLine: line,
    startColumn,
    endLine: line,
    endColumn,
}];

// {§matcher-dispatch} The matcher SELECTS a line; READ returns that line's
// CONTENT, not the matched token.
const doc = [
    "# Title",          // 1
    "alpha foo beta",   // 2 — one hit
    "gamma",            // 3
    "delta foo foo",    // 4 — two hits on one line (dedup)
].join("\n");

test("matcher: returns deduplicated readable-text regions", async () => {
    const mts = stubMimetypes(async () => [
        { regions: at(2, 7, 10), matched: "foo" },
        { regions: at(4, 7, 10), matched: "foo" },
        { regions: at(4, 7, 10), matched: "foo" },
    ]);
    const r = await Matcher.matchAgainstContent(regexBody, doc, "text/markdown", mts);
    assert.equal(r.status, 200);
    assert.deepEqual(r.matches, [
        { region: { startLine: 2, startColumn: 7, endLine: 2, endColumn: 10 } },
        { region: { startLine: 4, startColumn: 7, endLine: 4, endColumn: 10 } },
    ]);
    assert.equal(r.body, undefined);
});

test("matcher: a multi-line span remains one range", async () => {
    const mts = stubMimetypes(async () => [{
        regions: [{
            startLine: 2,
            startColumn: 1,
            endLine: 4,
            endColumn: 14,
        }],
        matched: "block",
    }]);
    const r = await Matcher.matchAgainstContent(regexBody, doc, "text/markdown", mts);
    assert.deepEqual(r.matches, [{
        region: {
            startLine: 2,
            startColumn: 1,
            endLine: 4,
            endColumn: 14,
        },
    }]);
});

test("matcher: passes the PARSED matcher to query (no re-parse), declared dialect authoritative", async () => {
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

test("matcher: a locator-only match selects without fabricated coordinates", async () => {
    const mts = stubMimetypes(async () => [{
        matched: 42,
        matching: "count(//item)",
    }]);
    const r = await Matcher.matchAgainstContent(
        { dialect: "xpath", raw: "count(//item)" } as MatcherBody,
        "irrelevant", "text/html", mts,
    );
    assert.equal(r.status, 200);
    assert.deepEqual(r.matches, [{ path: "count(//item)" }]);
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
        { regions: at(3, 7, 22), matched: "Alice", matching: "$.users[0].name" },
        { regions: at(4, 7, 20), matched: "Bob", matching: "$.users[1].name" },
    ]);
    const r = await Matcher.matchAgainstContent(
        { dialect: "jsonpath", raw: "$.users[*].name" } as MatcherBody,
        json, "application/json", mts,
    );
    assert.deepEqual(r.matches, [
        {
            path: "$.users[0].name",
            region: { startLine: 3, startColumn: 7, endLine: 3, endColumn: 22 },
        },
        {
            path: "$.users[1].name",
            region: { startLine: 4, startColumn: 7, endLine: 4, endColumn: 20 },
        },
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

test("matcher: malformed plugin evidence fails at the adapter boundary", async () => {
    const mts = stubMimetypes(async () => [{
        matched: "broken",
        regions: [{
            startLine: 2,
            startColumn: 1,
            endLine: 1,
            endColumn: 2,
        }],
    }]);
    await assert.rejects(
        Matcher.matchAgainstContent(regexBody, doc, "text/markdown", mts),
        /TextRegion/,
    );
});

test("matcher: UnsupportedDialectError → 415", async () => {
    const mts = stubMimetypes(async () => {
        throw new UnsupportedDialectError({
            mimetype: "image/png", dialect: "regex", reason: "binary content",
        });
    });
    const r = await Matcher.matchAgainstContent(regexBody, "x", "image/png", mts);
    assert.equal(r.status, 415);
    assert.equal(r.problem?.detail, "The regex matcher is not supported for image/png.");
    assert.equal(r.problem?.mimetype, "image/png");
    assert.equal(r.problem?.dialect, "regex");
    assert.equal(r.problem?.recovery, "Use a matcher supported by the resource mimetype.");
});

test("matcher: InvalidExpressionError → 400", async () => {
    const mts = stubMimetypes(async () => {
        throw new InvalidExpressionError({
            dialect: "regex", expression: "/[/", cause: new Error("unclosed bracket"),
        });
    });
    const r = await Matcher.matchAgainstContent(regexBody, "x", "text/markdown", mts);
    assert.equal(r.status, 400);
    assert.equal(r.problem?.detail, "The regex matcher expression is invalid.");
    assert.equal(r.problem?.dialect, "regex");
    assert.equal(r.problem?.recovery, "Correct or remove the matcher.");
    assert.equal("expression" in (r.problem ?? {}), false);
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
// zero runtime deps. Uses
// a real Mimetypes instance, not a stub, so a regression in the dep surfaces.
test("matcher: xpath dialect served by the framework, no local xml engine", async () => {
    const { Mimetypes } = await import("@plurnk/plurnk-mimetypes");
    const mts = new Mimetypes({ defaultMimetype: "text/markdown" });
    const xpathBody: MatcherBody = { dialect: "xpath", raw: "//item" };
    const xml = "<root>\n  <item>a</item>\n  <item>b</item>\n</root>";
    const r = await Matcher.matchAgainstContent(xpathBody, xml, "text/html", mts);
    assert.equal(r.status, 200);
    assert.deepEqual(r.matches, [
        { path: "(//item)[1]" },
        { path: "(//item)[2]" },
    ]);
});
