// Unit tests for matcher.ts. The dialect primitives (queryGlob, queryRegex,
// queryJsonpathObject) live in @plurnk/plurnk-mimetypes and run REAL here over
// fixed content — they're pure functions, so their output is deterministic.
// What plurnk-service OWNS and this file tests is the orchestration: dialect
// dispatch, the `<line>:\t<value>` rendering (§16.2), the <L> baseLine shift,
// and the status mapping (200/204/203/400/501). Only `mimetypes.process` (the
// structural projection) is stubbed — it's the one daughter method matcher.ts
// calls; glob/regex go straight to the imported primitives.

import test from "node:test";
import { strict as assert } from "node:assert";
import type { MatcherBody } from "@plurnk/plurnk-grammar";
import type { Mimetypes } from "@plurnk/plurnk-mimetypes";
import Matcher from "./matcher.ts";
import MimetypeBinary from "./mimetype-binary.ts";

// Stub the single daughter method matcher.ts invokes for structural dialects.
// `noProcess` is a never-called placeholder for the glob/regex tests (which
// bypass process entirely); the structural tests pass a real projection or throw.
const stubProcess = (impl: (input: { content: string; hint: string }) => Promise<{ deepJson: unknown; deepXml: string }>): Mimetypes =>
    ({ process: impl } as unknown as Mimetypes);
const noProcess = stubProcess(async () => ({ deepJson: null, deepXml: "" }));

const regexBody = (pattern: string): MatcherBody => ({ dialect: "regex", raw: `/${pattern}/`, pattern, flags: "" });

test("[§16.2-match-line-form] regex hits → 200, one `<line>:\\t<value>` per match", async () => {
    const r = await Matcher.matchAgainstContent(regexBody("foo"), "alpha\nfoo bar\nbeta\nfoo baz", "text/markdown", noProcess);
    assert.equal(r.status, 200);
    assert.equal(r.matches, 2);
    assert.equal(r.body, "2:\tfoo\n4:\tfoo");  // matched = the regex match, not the line
});

test("[§16.2-empty-204] matcher applied with zero hits → 204, no body", async () => {
    const r = await Matcher.matchAgainstContent(regexBody("zzz"), "alpha\nbeta", "text/markdown", noProcess);
    assert.equal(r.status, 204);
    assert.equal(r.matches, 0);
    assert.equal(r.body, undefined);
});

test("[§16.2-value-encoding] object hits → compact JSON one-per-line; the `matching` discriminator is dropped", async () => {
    // jsonpath runs over the daughter's deepJson projection (stubbed here). Both
    // hits resolve to source line 1; their distinguishing `matching` paths
    // ($['users'][0] / [1]) are NOT rendered — only line + value.
    const r = await Matcher.matchAgainstContent(
        { dialect: "jsonpath", raw: "$.users[*]" } as MatcherBody,
        '{"users":[{"name":"Alice","role":"admin"},{"name":"Bob"}]}', "application/json",
        stubProcess(async () => ({ deepJson: { users: [{ name: "Alice", role: "admin" }, { name: "Bob" }] }, deepXml: "" })),
    );
    assert.equal(r.status, 200);
    assert.equal(r.body, '1:\t{"name":"Alice","role":"admin"}\n1:\t{"name":"Bob"}');
});

test("regex capture groups render as a JSON-array value", async () => {
    const r = await Matcher.matchAgainstContent(regexBody("name: (\\w+)"), "name: Alice\nname: Bob", "text/markdown", noProcess);
    assert.equal(r.body, '1:\t["Alice"]\n2:\t["Bob"]');
});

test("glob extracts the whole matching source line", async () => {
    const r = await Matcher.matchAgainstContent({ dialect: "glob", raw: "*foo*" } as MatcherBody, "alpha\nfoo bar\nbeta", "text/markdown", noProcess);
    assert.equal(r.status, 200);
    assert.equal(r.body, "2:\tfoo bar");
});

test("<L> baseLine offset shifts hit lines back into source coordinates", async () => {
    // The matcher saw lines 1-2 of a slice that began at source line 10.
    const r = await Matcher.matchAgainstContent(regexBody("foo"), "foo\nfoo", "text/markdown", noProcess, 10);
    assert.equal(r.body, "10:\tfoo\n11:\tfoo");
});

test("baseLine=1 (no slice) leaves hit lines unshifted", async () => {
    const r = await Matcher.matchAgainstContent(regexBody("foo"), "x\nfoo", "text/markdown", noProcess, 1);
    assert.equal(r.body, "2:\tfoo");
});

test("source unparseable for its mimetype → 203 soft fallback with raw content + reason", async () => {
    const r = await Matcher.matchAgainstContent(
        { dialect: "jsonpath", raw: "$.field" } as MatcherBody,
        "{broken json", "application/json",
        stubProcess(async () => { throw new Error("unexpected token } in JSON"); }),
    );
    assert.equal(r.status, 203);
    assert.equal(r.body, "{broken json");  // raw bytes handed back so the model can regex/visual-parse
    assert.equal(r.mimetype, MimetypeBinary.TEXT_PRIMITIVE_MIMETYPE);
    assert.ok((r.reason ?? "").includes("unexpected token"));
});

test("malformed structural expression → 400 (model-facing, not a 500)", async () => {
    const r = await Matcher.matchAgainstContent(
        { dialect: "xpath", raw: "//[" } as MatcherBody,
        "<root><a/></root>", "text/html",
        stubProcess(async () => ({ deepJson: null, deepXml: "<root><a/></root>" })),
    );
    assert.equal(r.status, 400);
    assert.ok((r.error ?? "").length > 0);
});

test("semantic dialect → 501 (semantic similarity is parked)", async () => {
    const r = await Matcher.matchAgainstContent({ dialect: "semantic", raw: "~query" } as MatcherBody, "x", "text/markdown", noProcess);
    assert.equal(r.status, 501);
});
