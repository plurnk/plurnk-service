// Unit tests for matcher.ts adapter. The actual dialect dispatch lives
// in @plurnk/plurnk-mimetypes; what we test here is the error→status
// mapping, the baseLine offset, and the 204/200/203 result construction.

import test from "node:test";
import { strict as assert } from "node:assert";
import type { MatcherBody } from "@plurnk/plurnk-grammar";
import type { Mimetypes, QueryMatch } from "@plurnk/plurnk-mimetypes";
import {
    UnsupportedDialectError,
    InvalidExpressionError,
    QueryParseFailureError,
} from "@plurnk/plurnk-mimetypes";
import Matcher from "./matcher.ts";

// Stub factory: returns a Mimetypes-shaped object whose `query` resolves
// or rejects per the caller's spec. The adapter only touches `query`.
const stubMimetypes = (impl: (input: object, expression: string) => Promise<QueryMatch[]>): Mimetypes => {
    return { query: impl } as unknown as Mimetypes;
};

const regexBody: MatcherBody = { dialect: "regex", raw: "/foo/", pattern: "foo", flags: "" };

// A content-backed hit's footprint: one span anchored at line N (start === end
// for a single-line hit). Matches the mimetypes #41 QueryMatch.lines shape.
const at = (n: number) => [{ line: n, endLine: n }];

test("matcher: matches render as lean N:\\t<value> lines, one per match", async () => {
    const mts = stubMimetypes(async () => [
        { lines: at(3), matched: "foo" },
        { lines: at(7), matched: "foo" },
    ]);
    const r = await Matcher.matchAgainstContent(regexBody, "irrelevant", "text/markdown", mts);
    assert.equal(r.status, 200);
    assert.equal(r.matches, 2);
    assert.equal(r.body, "3:\tfoo\n7:\tfoo");
});

test("matcher: a multi-line span anchors on its start line", async () => {
    const mts = stubMimetypes(async () => [{ lines: [{ line: 4, endLine: 6 }], matched: "block" }]);
    const r = await Matcher.matchAgainstContent(regexBody, "irrelevant", "text/markdown", mts);
    assert.equal(r.body, "4:\tblock");
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
    const r = await Matcher.matchAgainstContent(regexBody, "irrelevant", "text/markdown", mts);
    assert.equal(r.status, 204);
    assert.equal(r.matches, 0);
    assert.equal(r.body, undefined);
});

test("matcher: baseLine offset shifts framework lines into source coordinates", async () => {
    const mts = stubMimetypes(async () => [
        { lines: at(1), matched: "foo" },
        { lines: at(3), matched: "foo" },
    ]);
    // Slice started at source line 10 — framework saw line 1 of the slice,
    // we report source line 10.
    const r = await Matcher.matchAgainstContent(regexBody, "irrelevant", "text/markdown", mts, 10);
    assert.equal(r.status, 200);
    assert.equal(r.body, "10:\tfoo\n12:\tfoo");
});

test("matcher: baseLine=1 (no slice) leaves lines unmodified", async () => {
    const mts = stubMimetypes(async () => [{ lines: at(5), matched: "foo" }]);
    const r = await Matcher.matchAgainstContent(regexBody, "irrelevant", "text/markdown", mts, 1);
    assert.equal(r.body, "5:\tfoo");
});

test("matcher: `matching` (resolved path) is dropped from the rendering (schemes#12)", async () => {
    const mts = stubMimetypes(async () => [
        { lines: at(3), matched: "Alice", matching: "$.users[0].name" },
        { lines: at(7), matched: "Bob", matching: "$.users[1].name" },
    ]);
    const r = await Matcher.matchAgainstContent(
        { dialect: "jsonpath", raw: "$.users[*].name" } as MatcherBody,
        "irrelevant", "application/json", mts,
    );
    // The structured {matched, matching} wrapper was the legibility barrier;
    // output is bare line-numbered values, no resolved-path noise.
    assert.equal(r.body, "3:\tAlice\n7:\tBob");
    assert.equal((r.body ?? "").includes("$.users"), false);
});

test("matcher: object/multi-line values are JSON-encoded to keep one match per line", async () => {
    const mts = stubMimetypes(async () => [
        { lines: at(3), matched: { name: "Alice", role: "admin" } },
        { lines: at(5), matched: "two\nlines" },
    ]);
    const r = await Matcher.matchAgainstContent(
        { dialect: "jsonpath", raw: "$.users[*]" } as MatcherBody,
        "irrelevant", "application/json", mts,
    );
    assert.equal(r.body, `3:\t{"name":"Alice","role":"admin"}\n5:\t"two\\nlines"`);
    // one line per match — split count equals match count
    assert.equal((r.body ?? "").split("\n").length, 2);
});

test("matcher: UnsupportedDialectError → 415", async () => {
    const mts = stubMimetypes(async () => {
        throw new UnsupportedDialectError({
            mimetype: "image/png", dialect: "regex", reason: "binary content",
        });
    });
    const r = await Matcher.matchAgainstContent(regexBody, "x", "image/png", mts);
    assert.equal(r.status, 415);
    assert.ok((r.error ?? "").length > 0);
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
});
