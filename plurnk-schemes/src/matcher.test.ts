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
import { matchAgainstContent } from "./matcher.ts";

// Stub factory: returns a Mimetypes-shaped object whose `query` resolves
// or rejects per the caller's spec. The adapter only touches `query`.
const stubMimetypes = (impl: (input: object, expression: string) => Promise<QueryMatch[]>): Mimetypes => {
    return { query: impl } as unknown as Mimetypes;
};

const regexBody: MatcherBody = { dialect: "regex", raw: "/foo/", pattern: "foo", flags: "" };

test("matcher: framework returns matches → status 200 with JSON-array body", async () => {
    const mts = stubMimetypes(async () => [
        { line: 3, matched: "foo" },
        { line: 7, matched: "foo" },
    ]);
    const r = await matchAgainstContent(regexBody, "irrelevant", "text/markdown", mts);
    assert.equal(r.status, 200);
    assert.equal(r.matches, 2);
    assert.deepEqual(JSON.parse(r.body ?? ""), [
        { line: 3, matched: "foo" },
        { line: 7, matched: "foo" },
    ]);
});

test("matcher: framework returns empty array → status 204", async () => {
    const mts = stubMimetypes(async () => []);
    const r = await matchAgainstContent(regexBody, "irrelevant", "text/markdown", mts);
    assert.equal(r.status, 204);
    assert.equal(r.matches, 0);
    assert.equal(r.body, undefined);
});

test("matcher: baseLine offset shifts framework lines into source coordinates", async () => {
    const mts = stubMimetypes(async () => [
        { line: 1, matched: "foo" },
        { line: 3, matched: "foo" },
    ]);
    // Slice started at source line 10 — framework saw line 1 of the slice,
    // we report source line 10.
    const r = await matchAgainstContent(regexBody, "irrelevant", "text/markdown", mts, 10);
    assert.equal(r.status, 200);
    const rows = JSON.parse(r.body ?? "") as Array<{ line: number }>;
    assert.deepEqual(rows.map((r) => r.line), [10, 12]);
});

test("matcher: baseLine=1 (no slice) leaves lines unmodified", async () => {
    const mts = stubMimetypes(async () => [{ line: 5, matched: "foo" }]);
    const r = await matchAgainstContent(regexBody, "irrelevant", "text/markdown", mts, 1);
    const rows = JSON.parse(r.body ?? "") as Array<{ line: number }>;
    assert.equal(rows[0].line, 5);
});

test("matcher: matching field preserved when framework provides it", async () => {
    const mts = stubMimetypes(async () => [
        { line: 3, matched: "Alice", matching: "$.users[0].name" },
        { line: 7, matched: "Bob", matching: "$.users[1].name" },
    ]);
    const r = await matchAgainstContent(
        { dialect: "jsonpath", raw: "$.users[*].name" } as MatcherBody,
        "irrelevant", "application/json", mts,
    );
    const rows = JSON.parse(r.body ?? "") as Array<{ matching?: string }>;
    assert.equal(rows[0].matching, "$.users[0].name");
    assert.equal(rows[1].matching, "$.users[1].name");
});

test("matcher: UnsupportedDialectError → 415", async () => {
    const mts = stubMimetypes(async () => {
        throw new UnsupportedDialectError({
            mimetype: "image/png", dialect: "regex", reason: "binary content",
        });
    });
    const r = await matchAgainstContent(regexBody, "x", "image/png", mts);
    assert.equal(r.status, 415);
    assert.ok((r.error ?? "").length > 0);
});

test("matcher: InvalidExpressionError → 400", async () => {
    const mts = stubMimetypes(async () => {
        throw new InvalidExpressionError({
            dialect: "regex", expression: "/[/", cause: new Error("unclosed bracket"),
        });
    });
    const r = await matchAgainstContent(regexBody, "x", "text/markdown", mts);
    assert.equal(r.status, 400);
});

test("matcher: QueryParseFailureError → 203 fallback with raw content + reason", async () => {
    const mts = stubMimetypes(async () => {
        throw new QueryParseFailureError({
            mimetype: "application/json", cause: new SyntaxError("unexpected token } in JSON"),
        });
    });
    const r = await matchAgainstContent(
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
        matchAgainstContent(regexBody, "x", "text/markdown", mts),
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
    const mts = new Mimetypes({ tokenize: async (t: string) => Math.ceil(t.length / 4), defaultMimetype: "text/markdown" });
    const xpathBody: MatcherBody = { dialect: "xpath", raw: "//item" };
    const xml = "<root>\n  <item>a</item>\n  <item>b</item>\n</root>";
    const r = await matchAgainstContent(xpathBody, xml, "text/html", mts);
    assert.equal(r.status, 200);
    assert.equal(r.matches, 2);
});
