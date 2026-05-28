import test from "node:test";
import { strict as assert } from "node:assert";
import { matchAgainstContent } from "./matcher.ts";

const parseBody = (s: string | undefined): unknown[] => {
    if (s === undefined) throw new Error("expected body");
    return JSON.parse(s);
};

// --- Regex: bare match (no captures) -----------------------------------

test("regex bare, no /g — first match only, full match as `matched`", () => {
    const r = matchAgainstContent(
        { dialect: "regex", raw: "/foo/", pattern: "foo", flags: "" },
        "foo bar foo baz", "text/plain",
    );
    assert.equal(r.status, 200);
    assert.equal(r.matches, 1);
    assert.deepEqual(parseBody(r.body), [{ line: 1, matched: "foo" }]);
});

test("regex bare, /g — all matches, one row per match", () => {
    const r = matchAgainstContent(
        { dialect: "regex", raw: "/foo/g", pattern: "foo", flags: "g" },
        "foo\nbar foo\nbaz", "text/plain",
    );
    assert.equal(r.status, 200);
    assert.equal(r.matches, 2);
    assert.deepEqual(parseBody(r.body), [
        { line: 1, matched: "foo" },
        { line: 2, matched: "foo" },
    ]);
});

// --- Regex: anonymous captures -----------------------------------------

test("regex single anon capture — `matched` is array of captures", () => {
    const r = matchAgainstContent(
        { dialect: "regex", raw: "/codename: (\\w+)/g", pattern: "codename: (\\w+)", flags: "g" },
        "codename: phoenix\ncodename: red", "text/plain",
    );
    assert.equal(r.status, 200);
    assert.equal(r.matches, 2);
    assert.deepEqual(parseBody(r.body), [
        { line: 1, matched: ["phoenix"] },
        { line: 2, matched: ["red"] },
    ]);
});

test("regex multi anon capture — `matched` is array of all captures", () => {
    const r = matchAgainstContent(
        { dialect: "regex", raw: "/(\\w+):\\s*(\\w+)/g", pattern: "(\\w+):\\s*(\\w+)", flags: "g" },
        "codename: phoenix\nbackup: red", "text/plain",
    );
    assert.equal(r.status, 200);
    assert.equal(r.matches, 2);
    assert.deepEqual(parseBody(r.body), [
        { line: 1, matched: ["codename", "phoenix"] },
        { line: 2, matched: ["backup", "red"] },
    ]);
});

// --- Regex: named captures ---------------------------------------------

test("regex single named capture — `matched` is object keyed by name", () => {
    const r = matchAgainstContent(
        { dialect: "regex", raw: "/codename: (?<name>\\w+)/g", pattern: "codename: (?<name>\\w+)", flags: "g" },
        "codename: phoenix\ncodename: red", "text/plain",
    );
    assert.equal(r.status, 200);
    assert.equal(r.matches, 2);
    assert.deepEqual(parseBody(r.body), [
        { line: 1, matched: { name: "phoenix" } },
        { line: 2, matched: { name: "red" } },
    ]);
});

test("regex multi named capture — `matched` is object keyed by names", () => {
    const r = matchAgainstContent(
        { dialect: "regex", raw: "/(?<key>\\w+):\\s*(?<val>\\w+)/g", pattern: "(?<key>\\w+):\\s*(?<val>\\w+)", flags: "g" },
        "codename: phoenix\nbackup: red", "text/plain",
    );
    assert.equal(r.status, 200);
    assert.equal(r.matches, 2);
    assert.deepEqual(parseBody(r.body), [
        { line: 1, matched: { key: "codename", val: "phoenix" } },
        { line: 2, matched: { key: "backup", val: "red" } },
    ]);
});

// --- Regex: empty result -----------------------------------------------

test("regex zero matches — status 204, no body", () => {
    const r = matchAgainstContent(
        { dialect: "regex", raw: "/nope/g", pattern: "nope", flags: "g" },
        "alpha\nbeta", "text/plain",
    );
    assert.equal(r.status, 204);
    assert.equal(r.matches, 0);
    assert.equal(r.body, undefined);
});

// --- Regex: source line tracking ---------------------------------------

test("regex source line — multi-line content with matches on different lines", () => {
    const r = matchAgainstContent(
        { dialect: "regex", raw: "/foo/g", pattern: "foo", flags: "g" },
        "one\ntwo\nfoo\nfour\nfoo\nsix\n", "text/plain",
    );
    assert.equal(r.status, 200);
    const rows = parseBody(r.body) as { line: number; matched: string }[];
    assert.deepEqual(rows.map((r) => r.line), [3, 5]);
});

test("regex baseLine — source positions when matcher runs inside an <L> slice", () => {
    // Sliced content "foo\nbar" came from source lines 10–11; baseLine=10.
    const r = matchAgainstContent(
        { dialect: "regex", raw: "/foo/g", pattern: "foo", flags: "g" },
        "foo\nbar", "text/plain", 10,
    );
    assert.equal(r.status, 200);
    const rows = parseBody(r.body) as { line: number }[];
    assert.equal(rows[0].line, 10);
});

// --- Mimetype gating ---------------------------------------------------

test("xpath on text/plain returns 415", () => {
    const r = matchAgainstContent({ dialect: "xpath", raw: "//user" }, "hello", "text/plain");
    assert.equal(r.status, 415);
});

test("jsonpath on text/html returns 415", () => {
    const r = matchAgainstContent({ dialect: "jsonpath", raw: "$.users" }, "<html/>", "text/html");
    assert.equal(r.status, 415);
});

test("xpath on text/html returns 501 with sibling-issue pointer", () => {
    const r = matchAgainstContent({ dialect: "xpath", raw: "//user" }, "<html/>", "text/html");
    assert.equal(r.status, 501);
    assert.match(r.error ?? "", /plurnk-mimetypes/);
});

test("jsonpath on application/json returns 501", () => {
    const r = matchAgainstContent({ dialect: "jsonpath", raw: "$.users" }, "{}", "application/json");
    assert.equal(r.status, 501);
});

test("any matcher on binary mimetype returns 415", () => {
    const r = matchAgainstContent(
        { dialect: "regex", raw: "/foo/", pattern: "foo", flags: "" },
        "x", "image/png",
    );
    assert.equal(r.status, 415);
});

test("glob over content returns 501 (use FIND paths)", () => {
    const r = matchAgainstContent({ dialect: "glob", raw: "*.md" }, "foo", "text/plain");
    assert.equal(r.status, 501);
});

test("regex malformed pattern returns 400", () => {
    const r = matchAgainstContent(
        { dialect: "regex", raw: "/[/", pattern: "[", flags: "" },
        "foo", "text/plain",
    );
    assert.equal(r.status, 400);
});
