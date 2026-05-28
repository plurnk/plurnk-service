import test from "node:test";
import { strict as assert } from "node:assert";
import { matchAgainstContent } from "./matcher.ts";

test("regex match returns first match without /g", () => {
    const r = matchAgainstContent(
        { dialect: "regex", raw: "/foo/", pattern: "foo", flags: "" },
        "foo bar foo baz", "text/plain",
    );
    assert.equal(r.status, 200);
    assert.deepEqual(r.matches, ["foo"]);
});

test("regex match returns all matches with /g", () => {
    const r = matchAgainstContent(
        { dialect: "regex", raw: "/foo/g", pattern: "foo", flags: "g" },
        "foo bar foo baz", "text/plain",
    );
    assert.equal(r.status, 200);
    assert.deepEqual(r.matches, ["foo", "foo"]);
});

test("regex pattern compile failure returns 400", () => {
    const r = matchAgainstContent(
        { dialect: "regex", raw: "/[/", pattern: "[", flags: "" },
        "foo", "text/plain",
    );
    assert.equal(r.status, 400);
});

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

test("xpath on application/xml accepted (501 not 415)", () => {
    const r = matchAgainstContent({ dialect: "xpath", raw: "//user" }, "<x/>", "application/xml");
    assert.equal(r.status, 501);
});

test("xpath on +xml suffix accepted", () => {
    const r = matchAgainstContent({ dialect: "xpath", raw: "//user" }, "<x/>", "image/svg+xml");
    assert.equal(r.status, 501);
});

test("jsonpath on +json suffix accepted", () => {
    const r = matchAgainstContent({ dialect: "jsonpath", raw: "$.x" }, "{}", "application/vnd.api+json");
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
