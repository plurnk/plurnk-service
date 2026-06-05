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

test("matcher: matches → status 200 with N:\\t<value> lines", async () => {
    const mts = stubMimetypes(async () => [
        { line: 3, matched: "foo" },
        { line: 7, matched: "foo" },
    ]);
    const r = await Matcher.matchAgainstContent(regexBody, "irrelevant", "text/markdown", mts);
    assert.equal(r.status, 200);
    assert.equal(r.matches, 2);
    assert.equal(r.body, "3:\tfoo\n7:\tfoo");
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
        { line: 1, matched: "foo" },
        { line: 3, matched: "foo" },
    ]);
    // Slice started at source line 10 — framework saw line 1 of the slice,
    // we report source line 10.
    const r = await Matcher.matchAgainstContent(regexBody, "irrelevant", "text/markdown", mts, 10);
    assert.equal(r.status, 200);
    assert.equal(r.body, "10:\tfoo\n12:\tfoo");
});

test("matcher: baseLine=1 (no slice) leaves lines unmodified", async () => {
    const mts = stubMimetypes(async () => [{ line: 5, matched: "foo" }]);
    const r = await Matcher.matchAgainstContent(regexBody, "irrelevant", "text/markdown", mts, 1);
    assert.equal(r.body, "5:\tfoo");
});

test("matcher: object values JSON-encoded one-per-line; resolved path dropped", async () => {
    const mts = stubMimetypes(async () => [
        { line: 3, matched: { name: "Alice", role: "admin" }, matching: "$.users[0]" },
        { line: 7, matched: "Bob", matching: "$.users[1].name" },
    ]);
    const r = await Matcher.matchAgainstContent(
        { dialect: "jsonpath", raw: "$.users[*]" } as MatcherBody,
        "irrelevant", "application/json", mts,
    );
    // object → compact JSON on one line; scalar → bare; the `matching` path is gone.
    assert.equal(r.body, '3:\t{"name":"Alice","role":"admin"}\n7:\tBob');
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
