import test from "node:test";
import assert from "node:assert/strict";
import { Validator } from "@plurnk/plurnk-contracts";
import { PlurnkParser } from "../../src/index.ts";

// -------------------------------------------------------------------------
// Position
// -------------------------------------------------------------------------

test("{§parser-position} Validator: Position accepts well-formed", () => {
    const { valid, errors } = Validator.validatePosition({ line: 1, column: 0 });
    assert.equal(valid, true);
    assert.deepEqual(errors, []);
});

test("{§parser-position} Validator: Position accepts only the complete unknown sentinel", () => {
    assert.equal(Validator.validatePosition({ line: 0, column: 0 }).valid, true);
    assert.equal(Validator.validatePosition({ line: 0, column: 1 }).valid, false);
});

test("{§parser-position} Validator: Position rejects missing column", () => {
    const { valid } = Validator.validatePosition({ line: 1 });
    assert.equal(valid, false);
});

test("{§parser-position} Validator: Position rejects missing line", () => {
    const { valid } = Validator.validatePosition({ column: 0 });
    assert.equal(valid, false);
});

test("{§parser-position} Validator: Position rejects negative line", () => {
    const { valid } = Validator.validatePosition({ line: -1, column: 0 });
    assert.equal(valid, false);
});

test("{§parser-position} Validator: Position rejects non-integer line", () => {
    const { valid } = Validator.validatePosition({ line: 1.5, column: 0 });
    assert.equal(valid, false);
});

test("{§parser-position} Validator: Position rejects extra property", () => {
    const { valid } = Validator.validatePosition({ line: 1, column: 0, foo: "bar" });
    assert.equal(valid, false);
});

// -------------------------------------------------------------------------
// LineMarker
// -------------------------------------------------------------------------

test("{§scope-slot} Validator: LineMarker accepts single-position", () => {
    const { valid } = Validator.validateLineMarker({ marks: [1] });
    assert.equal(valid, true);
});

test("{§scope-slot} Validator: LineMarker accepts range", () => {
    const { valid } = Validator.validateLineMarker({ marks: [1, 10] });
    assert.equal(valid, true);
});

test("{§scope-slot} Validator: LineMarker accepts negative sentinel (append)", () => {
    const { valid } = Validator.validateLineMarker({ marks: [-1] });
    assert.equal(valid, true);
});

test("{§scope-slot} Validator: LineMarker accepts zero sentinel (prepend)", () => {
    const { valid } = Validator.validateLineMarker({ marks: [0] });
    assert.equal(valid, true);
});

test("{§scope-slot} Validator: LineMarker accepts negative range", () => {
    const { valid } = Validator.validateLineMarker({ marks: [-3, -1] });
    assert.equal(valid, true);
});

test("{§scope-slot} Validator: LineMarker rejects empty marks", () => {
    const { valid } = Validator.validateLineMarker({ marks: [] });
    assert.equal(valid, false);
});

test("{§scope-slot} Validator: LineMarker rejects a non-number mark", () => {
    const { valid } = Validator.validateLineMarker({ marks: ["1"] });
    assert.equal(valid, false);
});

test("{§text-line-anchor-syntax} Validator: TextLineMarker accepts a five-character Base62 anchor", () => {
    const { valid, errors } = Validator.validateTextLineMarker({ marks: ["@aZ09b"] });
    assert.equal(valid, true, JSON.stringify(errors));
});

test("{§text-line-anchor-syntax} Validator: ordinary LineMarker rejects a text-coordinate anchor", () => {
    const { valid } = Validator.validateLineMarker({ marks: ["@aZ09b"] });
    assert.equal(valid, false);
});

test("{§scope-slot} Validator: LineMarker rejects extra property", () => {
    const { valid } = Validator.validateLineMarker({ marks: [1], extra: true });
    assert.equal(valid, false);
});

// -------------------------------------------------------------------------
// Round-trip: parser output validates against schemas
// -------------------------------------------------------------------------

test("{§parser-position} Round-trip: AST.position from parsed statement validates", () => {
    const result = PlurnkParser.parseStatements("````EDIT (p)\nbody\n````");
    const item = result.items[0];
    if (item.kind !== "statement") { assert.fail("expected statement"); return; }
    const { valid, errors } = Validator.validatePosition(item.statement.position);
    assert.equal(valid, true, `errors: ${JSON.stringify(errors)}`);
});

test("{§scope-slot} Round-trip: AST.lineMarker (single) from parsed statement validates", () => {
    const result = PlurnkParser.parseStatements("````FIND (p) <5> @m````");
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "FIND") { assert.fail("expected FIND"); return; }
    assert.ok(item.statement.lineMarker);
    const { valid, errors } = Validator.validateLineMarker(item.statement.lineMarker);
    assert.equal(valid, true, `errors: ${JSON.stringify(errors)}`);
});

test("{§scope-slot} Round-trip: AST.lineMarker (range) from parsed statement validates", () => {
    const result = PlurnkParser.parseStatements("````FIND (p) <1-10> @m````");
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "FIND") { assert.fail("expected FIND"); return; }
    assert.ok(item.statement.lineMarker);
    const { valid, errors } = Validator.validateLineMarker(item.statement.lineMarker);
    assert.equal(valid, true, `errors: ${JSON.stringify(errors)}`);
});

test("{§scope-slot} Round-trip: AST.lineMarker (append sentinel) from parsed statement validates", () => {
    const result = PlurnkParser.parseStatements("````EDIT (p) <-1>\nappended\n````");
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "EDIT") { assert.fail("expected EDIT"); return; }
    assert.ok(item.statement.lineMarker);
    const { valid, errors } = Validator.validateLineMarker(item.statement.lineMarker);
    assert.equal(valid, true, `errors: ${JSON.stringify(errors)}`);
});

test("{§parser-position} Round-trip: JSON-serialized AST.position round-trips through validator", () => {
    const result = PlurnkParser.parseStatements("````EDIT (p)\nbody\n````");
    const item = result.items[0];
    if (item.kind !== "statement") { assert.fail("expected statement"); return; }
    const serialized = JSON.stringify(item.statement.position);
    const reloaded = JSON.parse(serialized);
    const { valid } = Validator.validatePosition(reloaded);
    assert.equal(valid, true);
});

// -------------------------------------------------------------------------
// ParsedPath
// -------------------------------------------------------------------------

test("{§path-syntax} Validator: ParsedPath accepts local", () => {
    const { valid } = Validator.validateParsedPath({ kind: "local", raw: "config/foo.xml" });
    assert.equal(valid, true);
});

test("{§path-syntax} Validator: ParsedPath accepts url with full decomposition", () => {
    const { valid } = Validator.validateParsedPath({
        kind: "url",
        raw: "https://example.com:8080/path?q=1#frag",
        scheme: "https",
        username: null,
        password: null,
        hostname: "example.com",
        port: 8080,
        pathname: "/path",
        query: "q=1",
        fragment: "frag",
    });
    assert.equal(valid, true);
});

test("{§path-syntax} Validator: ParsedPath accepts url with null authority fields", () => {
    const { valid } = Validator.validateParsedPath({
        kind: "url",
        raw: "worker://philosophy",
        scheme: "worker",
        username: null,
        password: null,
        hostname: "philosophy",
        port: null,
        pathname: "",
        query: null,
        fragment: null,
    });
    assert.equal(valid, true);
});

test("{§path-syntax} Validator: ParsedPath rejects unknown kind", () => {
    const { valid } = Validator.validateParsedPath({ kind: "remote", raw: "foo" });
    assert.equal(valid, false);
});

test("{§path-syntax} Validator: ParsedPath rejects url missing required field", () => {
    const { valid } = Validator.validateParsedPath({
        kind: "url",
        raw: "https://example.com/",
        scheme: "https",
    });
    assert.equal(valid, false);
});

test("{§path-query} Validator: ParsedPath accepts an ordered query component", () => {
    const { valid } = Validator.validateParsedPath({
        kind: "url",
        raw: "https://example.com/?q=1&q=2",
        scheme: "https",
        username: null,
        password: null,
        hostname: "example.com",
        port: null,
        pathname: "/",
        query: "q=1&q=2",
        fragment: null,
    });
    assert.equal(valid, true);
});

test("{§path-syntax} Round-trip: AST.target (local) validates", () => {
    const result = PlurnkParser.parseStatements("````EDIT (config/foo.xml)\nbody\n````");
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "EDIT") { assert.fail("expected EDIT statement"); return; }
    assert.ok(item.statement.target);
    const { valid, errors } = Validator.validateParsedPath(item.statement.target);
    assert.equal(valid, true, `errors: ${JSON.stringify(errors)}`);
});

test("{§path-syntax} Round-trip: AST.target (url) validates after JSON round-trip", () => {
    const result = PlurnkParser.parseStatements("````EDIT (https://example.com:8080/p?q=1&q=2#frag)\nbody\n````");
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "EDIT") { assert.fail("expected EDIT statement"); return; }
    const reloaded = JSON.parse(JSON.stringify(item.statement.target));
    const { valid, errors } = Validator.validateParsedPath(reloaded);
    assert.equal(valid, true, `errors: ${JSON.stringify(errors)}`);
});

// -------------------------------------------------------------------------
// MatcherBody
// -------------------------------------------------------------------------

test("{§matcher-prefix-claims} Validator: MatcherBody accepts xpath", () => {
    const { valid } = Validator.validateMatcherBody({ dialect: "xpath", raw: "//user[@role]" });
    assert.equal(valid, true);
});

test("{§matcher-prefix-claims} Validator: MatcherBody accepts regex with pattern+flags", () => {
    const { valid } = Validator.validateMatcherBody({
        dialect: "regex",
        raw: "/foo|bar/i",
        pattern: "foo|bar",
        flags: "i",
    });
    assert.equal(valid, true);
});

test("{§matcher-prefix-claims} Validator: MatcherBody accepts jsonpath", () => {
    const { valid } = Validator.validateMatcherBody({ dialect: "jsonpath", raw: "$.greeting" });
    assert.equal(valid, true);
});

test("{§matcher-prefix-claims} Validator: MatcherBody accepts glob", () => {
    for (const raw of ["*.xml", "@literal", "@(xml|json)"] as const) {
        const { valid } = Validator.validateMatcherBody({ dialect: "glob", raw });
        assert.equal(valid, true, raw);
    }
});

test("{§matcher-prefix-claims} Validator: MatcherBody accepts only canonical single-line graph forms", () => {
    for (const raw of ["&symbol", "&<symbol", "&>symbol"]) {
        assert.equal(Validator.validateMatcherBody({ dialect: "graph", raw }).valid, true, raw);
    }
    for (const raw of ["@symbol", "&", "&two symbols", "&symbol\n&other"]) {
        assert.equal(Validator.validateMatcherBody({ dialect: "graph", raw }).valid, false, raw);
    }
});

test("{§pattern-body-single-line} Validator: every matcher dialect rejects multiline raw input", () => {
    for (const matcher of [
        { dialect: "xpath", raw: "//one\n//two" },
        { dialect: "regex", raw: "/one/\n/two/", pattern: "one", flags: "" },
        { dialect: "jsonpath", raw: "$.one\n$.two" },
        { dialect: "fts", raw: "~one\ntwo" },
        { dialect: "glob", raw: "one\ntwo" },
    ]) {
        assert.equal(Validator.validateMatcherBody(matcher).valid, false, matcher.dialect);
    }
});

test("{§matcher-prefix-claims} Validator: MatcherBody rejects unknown dialect", () => {
    const { valid } = Validator.validateMatcherBody({ dialect: "sql", raw: "SELECT *" });
    assert.equal(valid, false);
});

test("{§matcher-prefix-claims} Validator: MatcherBody rejects regex missing pattern/flags", () => {
    const { valid } = Validator.validateMatcherBody({ dialect: "regex", raw: "/foo/i" });
    assert.equal(valid, false);
});

test("{§matcher-prefix-claims} Round-trip: AST.matcher (regex MatcherBody) validates", () => {
    const result = PlurnkParser.parseStatements("````FIND (p) /foo|bar/i````");
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "FIND") { assert.fail("expected FIND"); return; }
    assert.ok(item.statement.matcher);
    const { valid, errors } = Validator.validateMatcherBody(item.statement.matcher);
    assert.equal(valid, true, `errors: ${JSON.stringify(errors)}`);
});

test("{§matcher-prefix-claims} Round-trip: AST.matcher (xpath MatcherBody) validates", () => {
    const result = PlurnkParser.parseStatements("````FIND (p) //user[@role]````");
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "FIND") { assert.fail("expected FIND"); return; }
    assert.ok(item.statement.matcher);
    const { valid, errors } = Validator.validateMatcherBody(item.statement.matcher);
    assert.equal(valid, true, `errors: ${JSON.stringify(errors)}`);
});

test("{§matcher-prefix-claims} Round-trip: AST.matcher (jsonpath MatcherBody) validates", () => {
    const result = PlurnkParser.parseStatements("````FIND (p) $.field````");
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "FIND") { assert.fail("expected FIND"); return; }
    assert.ok(item.statement.matcher);
    const { valid, errors } = Validator.validateMatcherBody(item.statement.matcher);
    assert.equal(valid, true, `errors: ${JSON.stringify(errors)}`);
});

test("{§matcher-prefix-claims} Round-trip: AST.matcher (glob MatcherBody) validates", () => {
    const result = PlurnkParser.parseStatements("````FIND (p) @*.xml````");
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "FIND") { assert.fail("expected FIND"); return; }
    assert.ok(item.statement.matcher);
    const { valid, errors } = Validator.validateMatcherBody(item.statement.matcher);
    assert.equal(valid, true, `errors: ${JSON.stringify(errors)}`);
});

// -------------------------------------------------------------------------
// SendBody
// -------------------------------------------------------------------------

test("{§send-body} Validator: SendBody accepts plain text body", () => {
    const { valid } = Validator.validateSendBody({ raw: "Paris", json: null });
    assert.equal(valid, true);
});

test("{§send-body} Validator: SendBody accepts JSON body with parsed value", () => {
    const { valid } = Validator.validateSendBody({
        raw: '{"answer":"Paris"}',
        json: { answer: "Paris" },
    });
    assert.equal(valid, true);
});

test("{§send-body} Validator: SendBody accepts JSON array", () => {
    const { valid } = Validator.validateSendBody({ raw: "[1,2,3]", json: [1, 2, 3] });
    assert.equal(valid, true);
});

test("{§send-body} Validator: SendBody accepts json field as any primitive", () => {
    assert.equal(Validator.validateSendBody({ raw: "42", json: 42 }).valid, true);
    assert.equal(Validator.validateSendBody({ raw: "true", json: true }).valid, true);
    assert.equal(Validator.validateSendBody({ raw: "\"s\"", json: "s" }).valid, true);
});

test("{§send-body} Validator: SendBody rejects missing raw", () => {
    const { valid } = Validator.validateSendBody({ json: null });
    assert.equal(valid, false);
});

test("{§send-body} Round-trip: AST.body (SendBody with JSON) validates", () => {
    const result = PlurnkParser.parseStatements("````SEND\n{\"answer\":\"Paris\"}\n````\n````WAIT\n````");
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "SEND") { assert.fail("expected SEND"); return; }
    assert.ok(item.statement.body);
    const { valid, errors } = Validator.validateSendBody(item.statement.body);
    assert.equal(valid, true, `errors: ${JSON.stringify(errors)}`);
});

test("{§send-body} Round-trip: AST.body (SendBody plain text) validates", () => {
    const result = PlurnkParser.parseStatements("````SEND\nParis\n````\n````WAIT\n````");
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "SEND") { assert.fail("expected SEND"); return; }
    assert.ok(item.statement.body);
    const { valid, errors } = Validator.validateSendBody(item.statement.body);
    assert.equal(valid, true, `errors: ${JSON.stringify(errors)}`);
});
