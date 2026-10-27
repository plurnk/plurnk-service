import test, { describe } from "node:test";
import Matcher from "./matcher.ts";
import MimetypeBinary from "./mimetype-binary.ts";
import PathMimetype from "./path-mimetype.ts";
import { strict as assert } from "node:assert";
import { type MatcherBody } from "@plurnk/plurnk-contracts";
import { Mimetypes, type QueryMatch, type ParsedBodyMatcher, InvalidExpressionError, QueryParseFailureError } from "@plurnk/plurnk-mimetypes";

describe("matcher", () => {
const stubQuery = (impl: (input: { content: string; hint: string }, matcher: ParsedBodyMatcher) => Promise<QueryMatch[]>): Mimetypes =>
    ({ query: impl } as unknown as Mimetypes);

// A single-line hit in the exact text the model can READ.
const hit = (line: number, matched: unknown): QueryMatch =>
    ({
        matched,
        matching: `#${line}`,
        regions: [{
            startLine: line,
            startColumn: 1,
            endLine: line,
            endColumn: 2,
        }],
    });

const regexBody = (pattern: string): MatcherBody => ({ dialect: "regex", raw: `/${pattern}/`, pattern, flags: "" });

test("{§mimetype-query} regex hits select the resource and retain readable-text regions", async () => {
    const content = "alpha\nfoo bar\nbeta\nfoo baz";
    const r = await Matcher.matchAgainstContent(regexBody("foo"), content, "text/markdown",
        stubQuery(async () => [hit(2, "foo"), hit(4, "foo")]));
    assert.equal(r.status, 200);
    assert.deepEqual(r.matches, [
        {
            locator: "#2",
            region: { startLine: 2, startColumn: 1, endLine: 2, endColumn: 2 },
        },
        {
            locator: "#4",
            region: { startLine: 4, startColumn: 1, endLine: 4, endColumn: 2 },
        },
    ]);
    assert.equal(r.body, undefined);
});

test("{§matcher-dispatch} matcher applied with zero hits → 204, no body", async () => {
    const r = await Matcher.matchAgainstContent(regexBody("zzz"), "alpha\nbeta", "text/markdown",
        stubQuery(async () => []));
    assert.equal(r.status, 204);
    assert.deepEqual(r.matches, []);
    assert.equal(r.body, undefined);
});

test("{§matcher-dispatch} structural hits expose coordinates rather than extracted values", async () => {
    // jsonpath $.users[*] over multi-line JSON: each object resolves to the line it sits on.
    const content = '{\n  "users": [\n    { "name": "Alice", "role": "admin" },\n    { "name": "Bob" }\n  ]\n}';
    const r = await Matcher.matchAgainstContent(
        { dialect: "jsonpath", raw: "$.users[*]" }, content, "application/json",
        stubQuery(async () => [hit(3, { name: "Alice", role: "admin" }), hit(4, { name: "Bob" })]));
    assert.equal(r.status, 200);
    assert.deepEqual(r.matches, [
        {
            locator: "#3",
            region: { startLine: 3, startColumn: 1, endLine: 3, endColumn: 2 },
        },
        {
            locator: "#4",
            region: { startLine: 4, startColumn: 1, endLine: 4, endColumn: 2 },
        },
    ]);
});

test("{§mimetype-query} two structural matches on one line retain distinct canonical paths", async () => {
    const r = await Matcher.matchAgainstContent(
        { dialect: "jsonpath", raw: "$.users[*].name" },
        '{"users":[{"name":"Alice"},{"name":"Bob"}]}', "application/json",
        stubQuery(async () => [
            { ...hit(1, "Alice"), matching: "$.users[0].name" },
            { ...hit(1, "Bob"), matching: "$.users[1].name" },
        ]));
    assert.equal(r.status, 200);
    assert.deepEqual(r.matches, [
        {
            locator: "$.users[0].name",
            region: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 },
        },
        {
            locator: "$.users[1].name",
            region: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 },
        },
    ]);
});

test("{§mimetype-query} a multi-line match remains one coordinate range", async () => {
    const content = "<root>\n  <user>\n    Alice\n  </user>\n</root>";
    const r = await Matcher.matchAgainstContent(
        { dialect: "xpath", raw: "//user" }, content, "text/html",
        stubQuery(async () => [{
            matched: "<user>...</user>",
            matching: "(//user)[1]",
            regions: [{
                startLine: 2,
                startColumn: 1,
                endLine: 4,
                endColumn: 10,
            }],
        }]));
    assert.equal(r.status, 200);
    assert.deepEqual(r.matches, [{
        locator: "(//user)[1]",
        region: {
            startLine: 2,
            startColumn: 1,
            endLine: 4,
            endColumn: 10,
        },
    }]);
});

test("{§mimetype-query} a scalar retains its locator without fabricated coordinates", async () => {
    const r = await Matcher.matchAgainstContent(
        { dialect: "xpath", raw: "count(//user)" }, "<root><user/><user/></root>", "text/html",
        stubQuery(async () => [{ matched: 2, matching: "count(//user)" }]));
    assert.equal(r.status, 200);
    assert.deepEqual(r.matches, [{ locator: "count(//user)" }]);
});

test("{§matcher-dispatch} source unparseable for its mimetype → 203 soft fallback with raw content + reason", async () => {
    const r = await Matcher.matchAgainstContent(
        { dialect: "jsonpath", raw: "$.field" }, "{broken json", "application/json",
        stubQuery(async () => { throw new QueryParseFailureError({ mimetype: "application/json", cause: new Error("unexpected token } in JSON") }); }));
    assert.equal(r.status, 203);
    assert.equal(r.body, "{broken json");  // raw bytes handed back so the model can regex/visual-parse
    assert.equal(r.mimetype, MimetypeBinary.TEXT_PRIMITIVE_MIMETYPE);
    assert.ok((r.reason ?? "").includes("Failed to parse content for query"));  // the handler's templated reason
});

test("{§slicer-text-algebra} malformed matcher expression → 400 (model-facing, not a 500)", async () => {
    const r = await Matcher.matchAgainstContent(
        { dialect: "xpath", raw: "//[" }, "<root><a/></root>", "text/html",
        stubQuery(async () => { throw new InvalidExpressionError({ dialect: "xpath", expression: "//[" }); }));
    assert.equal(r.status, 400);
    assert.equal(r.problem?.type, "https://problems.plurnk.xyz/schemes/matcher/invalid-expression");
    assert.equal(r.problem?.stage, "matcher");
    assert.equal(r.problem?.dialect, "xpath");
    assert.equal("diagnostic" in (r.problem ?? {}), false, "an unavailable native cause is not guessed");
    assert.equal(r.problem?.recovery, "Revise the matcher expression."); // {§slicer-text-algebra}
    assert.equal(r.problem?.retryable, false);
});

test("{§mimetype-query} relation dialects (~full-text / &graph) never reach the content matcher", async () => {
    // Invariant: both relation dialects resolve through the persistent search index to
    // (resource, span) items; neither is a content matcher. Reaching matchAgainstContent with one is a
    // routing bug → fail hard, not a silent 501/400.
    const stub = stubQuery(async () => { throw new Error("query must not be called for a relation dialect"); });
    await assert.rejects(Matcher.matchAgainstContent({ dialect: "fts", raw: "~query" }, "x", "text/markdown", stub), /content-only/);
    await assert.rejects(Matcher.matchAgainstContent({ dialect: "graph", raw: "&graph" }, "x", "text/markdown", stub), /content-only/);
});

test("{§find} #449: one crashing candidate drops out; the operation and its siblings survive", async () => {
    const crashing = stubQuery(async ({ content }) => {
        if (content === "poison") throw new TypeError("Cannot read properties of null (reading 'tagName')");
        return content.includes("foo") ? [hit(1, "foo")] : [];
    });
    const r = await Matcher.matchCandidates(regexBody("foo"), [
        { key: "a.md", content: "foo here", mimetype: "text/markdown" },
        { key: "partial.html", content: "poison", mimetype: "text/html" },
        { key: "b.md", content: "foo too", mimetype: "text/markdown" },
    ], crashing);
    assert.equal(r.status, 200);
    assert.deepEqual(r.matches.map(({ key }) => key), ["a.md", "b.md"], "the crash is per-candidate");

    const allCrash = await Matcher.matchCandidates(regexBody("foo"), [
        { key: "one.html", content: "poison", mimetype: "text/html" },
        { key: "two.html", content: "poison", mimetype: "text/html" },
    ], crashing);
    assert.equal(allCrash.status, 415);
    assert.equal(allCrash.problem?.title, "Content handler crashed");
    assert.match(allCrash.problem?.detail, /text\/html content handler failed on one\.html/);
});
});

describe("path-mimetype", async () => {
const mimetypes = new Mimetypes();
await mimetypes.ready();

test("{§zero-width-column-one-insert} PathMimetype.resolveEntryMimetype: no extension → scheme default", async () => {
    assert.equal(await PathMimetype.resolveEntryMimetype("users", "text/markdown", mimetypes), "text/markdown");
    assert.equal(await PathMimetype.resolveEntryMimetype("notes", "text/plain", mimetypes), "text/plain");
});

test("{§zero-width-column-one-insert} PathMimetype.resolveEntryMimetype: leading-dot file is not an extension", async () => {
    // `.env` is a filename, not an extension; falls back to scheme default.
    assert.equal(await PathMimetype.resolveEntryMimetype(".env", "text/markdown", mimetypes), "text/markdown");
});

test("{§zero-width-column-one-insert} PathMimetype.resolveEntryMimetype: unknown extension → scheme default", async () => {
    // .xyz isn't a registered mimetype handler; detect returns null;
    // resolver falls back to scheme default.
    const result = await PathMimetype.resolveEntryMimetype("data.xyz", "text/markdown", mimetypes);
    assert.equal(result, "text/markdown");
});
});
