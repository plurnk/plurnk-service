import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { Validator } from "@plurnk/plurnk-contracts";
import { PlurnkParser, parsePath } from "../../src/index.ts";

describe("validator", () => {
test("{§parse-recovery} Validator: Position accepts well-formed", () => {
    const { valid, errors } = Validator.validatePosition({ line: 1, column: 0 });
    assert.equal(valid, true);
    assert.deepEqual(errors, []);
});

test("{§parse-recovery} Validator: Position accepts only the complete unknown sentinel", () => {
    assert.equal(Validator.validatePosition({ line: 0, column: 0 }).valid, true);
    assert.equal(Validator.validatePosition({ line: 0, column: 1 }).valid, false);
});

test("{§parse-recovery} Validator: Position rejects missing column", () => {
    const { valid } = Validator.validatePosition({ line: 1 });
    assert.equal(valid, false);
});

test("{§parse-recovery} Validator: Position rejects missing line", () => {
    const { valid } = Validator.validatePosition({ column: 0 });
    assert.equal(valid, false);
});

test("{§parse-recovery} Validator: Position rejects negative line", () => {
    const { valid } = Validator.validatePosition({ line: -1, column: 0 });
    assert.equal(valid, false);
});

test("{§parse-recovery} Validator: Position rejects non-integer line", () => {
    const { valid } = Validator.validatePosition({ line: 1.5, column: 0 });
    assert.equal(valid, false);
});

test("{§parse-recovery} Validator: Position rejects extra property", () => {
    const { valid } = Validator.validatePosition({ line: 1, column: 0, foo: "bar" });
    assert.equal(valid, false);
});

// -------------------------------------------------------------------------
// LineMarker
// -------------------------------------------------------------------------

test("{§matcher-prefix-claims} Validator: LineMarker accepts single-position", () => {
    const { valid } = Validator.validateLineMarker({ marks: [1] });
    assert.equal(valid, true);
});

test("{§matcher-prefix-claims} Validator: LineMarker accepts range", () => {
    const { valid } = Validator.validateLineMarker({ marks: [1, 10] });
    assert.equal(valid, true);
});

test("{§matcher-prefix-claims} Validator: LineMarker accepts negative sentinel (append)", () => {
    const { valid } = Validator.validateLineMarker({ marks: [-1] });
    assert.equal(valid, true);
});

test("{§matcher-prefix-claims} Validator: LineMarker accepts zero sentinel (prepend)", () => {
    const { valid } = Validator.validateLineMarker({ marks: [0] });
    assert.equal(valid, true);
});

test("{§matcher-prefix-claims} Validator: LineMarker accepts negative range", () => {
    const { valid } = Validator.validateLineMarker({ marks: [-3, -1] });
    assert.equal(valid, true);
});

test("{§matcher-prefix-claims} Validator: LineMarker rejects empty marks", () => {
    const { valid } = Validator.validateLineMarker({ marks: [] });
    assert.equal(valid, false);
});

test("{§matcher-prefix-claims} Validator: LineMarker rejects a non-number mark", () => {
    const { valid } = Validator.validateLineMarker({ marks: ["1"] });
    assert.equal(valid, false);
});

test("{§matcher-prefix-claims} Validator: TextLineMarker accepts a five-character Base62 anchor", () => {
    const { valid, errors } = Validator.validateTextLineMarker({ marks: ["@aZ09b"] });
    assert.equal(valid, true, JSON.stringify(errors));
});

test("{§matcher-prefix-claims} Validator: ordinary LineMarker rejects a text-coordinate anchor", () => {
    const { valid } = Validator.validateLineMarker({ marks: ["@aZ09b"] });
    assert.equal(valid, false);
});

test("{§matcher-prefix-claims} Validator: LineMarker rejects extra property", () => {
    const { valid } = Validator.validateLineMarker({ marks: [1], extra: true });
    assert.equal(valid, false);
});

// -------------------------------------------------------------------------
// Round-trip: parser output validates against schemas
// -------------------------------------------------------------------------

test("{§parse-recovery} Round-trip: AST.position from parsed statement validates", () => {
    const result = PlurnkParser.parseStatements("````EDIT (p)\nbody\n````");
    const item = result.items[0];
    if (item.kind !== "statement") { assert.fail("expected statement"); return; }
    const { valid, errors } = Validator.validatePosition(item.statement.position);
    assert.equal(valid, true, `errors: ${JSON.stringify(errors)}`);
});

test("{§matcher-prefix-claims} Round-trip: AST.lineMarker (single) from parsed statement validates", () => {
    const result = PlurnkParser.parseStatements("````FIND (p) <5> @m````");
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "FIND") { assert.fail("expected FIND"); return; }
    assert.ok(item.statement.lineMarker);
    const { valid, errors } = Validator.validateLineMarker(item.statement.lineMarker);
    assert.equal(valid, true, `errors: ${JSON.stringify(errors)}`);
});

test("{§matcher-prefix-claims} Round-trip: AST.lineMarker (range) from parsed statement validates", () => {
    const result = PlurnkParser.parseStatements("````FIND (p) <1-10> @m````");
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "FIND") { assert.fail("expected FIND"); return; }
    assert.ok(item.statement.lineMarker);
    const { valid, errors } = Validator.validateLineMarker(item.statement.lineMarker);
    assert.equal(valid, true, `errors: ${JSON.stringify(errors)}`);
});

test("{§matcher-prefix-claims} Round-trip: AST.lineMarker (append sentinel) from parsed statement validates", () => {
    const result = PlurnkParser.parseStatements("````EDIT (p) <-1>\nappended\n````");
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "EDIT") { assert.fail("expected EDIT"); return; }
    assert.ok(item.statement.lineMarker);
    const { valid, errors } = Validator.validateLineMarker(item.statement.lineMarker);
    assert.equal(valid, true, `errors: ${JSON.stringify(errors)}`);
});

test("{§parse-recovery} Round-trip: JSON-serialized AST.position round-trips through validator", () => {
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
        raw: "session://philosophy",
        scheme: "session",
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

test("{§path-syntax} Validator: ParsedPath accepts an ordered query component", () => {
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

test("{§matcher-prefix-claims} Validator: every matcher dialect rejects multiline raw input", () => {
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

test("{§op-shapes} Validator: SendBody accepts plain text body", () => {
    const { valid } = Validator.validateSendBody({ raw: "Paris", json: null });
    assert.equal(valid, true);
});

test("{§op-shapes} Validator: SendBody accepts JSON body with parsed value", () => {
    const { valid } = Validator.validateSendBody({
        raw: '{"answer":"Paris"}',
        json: { answer: "Paris" },
    });
    assert.equal(valid, true);
});

test("{§op-shapes} Validator: SendBody accepts JSON array", () => {
    const { valid } = Validator.validateSendBody({ raw: "[1,2,3]", json: [1, 2, 3] });
    assert.equal(valid, true);
});

test("{§op-shapes} Validator: SendBody accepts json field as any primitive", () => {
    assert.equal(Validator.validateSendBody({ raw: "42", json: 42 }).valid, true);
    assert.equal(Validator.validateSendBody({ raw: "true", json: true }).valid, true);
    assert.equal(Validator.validateSendBody({ raw: "\"s\"", json: "s" }).valid, true);
});

test("{§op-shapes} Validator: SendBody rejects missing raw", () => {
    const { valid } = Validator.validateSendBody({ json: null });
    assert.equal(valid, false);
});

test("{§op-shapes} Round-trip: AST.body (SendBody with JSON) validates", () => {
    const result = PlurnkParser.parseStatements("````SEND\n{\"answer\":\"Paris\"}\n````\n````WAIT\n````");
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "SEND") { assert.fail("expected SEND"); return; }
    assert.ok(item.statement.body);
    const { valid, errors } = Validator.validateSendBody(item.statement.body);
    assert.equal(valid, true, `errors: ${JSON.stringify(errors)}`);
});

test("{§op-shapes} Round-trip: AST.body (SendBody plain text) validates", () => {
    const result = PlurnkParser.parseStatements("````SEND\nParis\n````\n````WAIT\n````");
    const item = result.items[0];
    if (item.kind !== "statement" || item.statement.op !== "SEND") { assert.fail("expected SEND"); return; }
    assert.ok(item.statement.body);
    const { valid, errors } = Validator.validateSendBody(item.statement.body);
    assert.equal(valid, true, `errors: ${JSON.stringify(errors)}`);
});
});

describe("validator-statement", () => {
const validateRoundTrip = (input: string) => {
    const result = PlurnkParser.parseStatements(input);
    const item = result.items[0];
    assert.equal(item.kind, "statement", `parser did not return a statement for: ${input}`);
    if (item.kind !== "statement") return null;
    const json = JSON.parse(JSON.stringify(item.statement));
    return Validator.validatePlurnkStatement(json);
};

// -------------------------------------------------------------------------
// Round-trip per op
// -------------------------------------------------------------------------

test("{§op-shapes} PlurnkStatement: FIND with tag CSV, path, line marker, matcher", () => {
    const r = validateRoundTrip("````FIND (workspace:///docs) <1-20> @*.xml````");
    assert.equal(r!.valid, true, JSON.stringify(r!.errors));
});

test("{§op-shapes} PlurnkStatement: READ with bare local path and empty body", () => {
    const r = validateRoundTrip("````READ (config/foo.json)````");
    assert.equal(r!.valid, true, JSON.stringify(r!.errors));
});

test("{§op-shapes} PlurnkStatement: KILL with regex matcher", () => {
    const r = validateRoundTrip("````KILL (workspace:///**) /error|fail/i````");
    assert.equal(r!.valid, true, JSON.stringify(r!.errors));
});

test("{§op-shapes}: a completion reply preserves its literal answer and optional aside", () => {
    for (const body of [null, "The answer is **42**.", "SEND (session://alice)\n```sh\necho 42\n```", "{\"answer\":42}"]) {
        const source = PlurnkParser.frame("SEND [200] <!-- final answer -->", body);
        const result = PlurnkParser.parse(source);
        assert.equal(result.items.length, 1, "a final body is not a matcher or parser advisory");
        const item = result.items[0];
        assert.equal(item.kind, "statement");
        if (item.kind !== "statement" || item.statement.op !== "SEND") assert.fail("expected SEND");
        assert.equal(item.statement.body?.raw ?? null, body);
        assert.equal(item.statement.aside, "final answer");
        assert.equal(validateRoundTrip(source)?.valid, true);
    }
});

test("{§op-shapes} PlurnkStatement: KILL with jsonpath matcher", () => {
    const r = validateRoundTrip("````KILL (log://**) $.status````");
    assert.equal(r!.valid, true, JSON.stringify(r!.errors));
});

test("{§op-shapes} PlurnkStatement: KILL admits log-body line markers", () => {
    const parsed = PlurnkParser.parseStatements("````KILL (log://**) <17,-1>````");
    const item = parsed.items[0];
    assert.equal(item.kind, "statement");
    if (item.kind !== "statement" || item.statement.op !== "KILL") assert.fail("expected KILL");
    assert.deepEqual(item.statement.lineMarker, { marks: [17, -1] });

    const anchored = Validator.validatePlurnkStatement({
        ...JSON.parse(JSON.stringify(item.statement)),
        lineMarker: { marks: ["@aB3dE"] },
    });
    assert.equal(anchored.valid, true, "KILL schema must admit a line anchor");
});

test("{§op-shapes} PlurnkStatement: EDIT with raw markdown body", () => {
    const r = validateRoundTrip("````EDIT (workspace:///meaning)\nThe meaning of life is 42\n````");
    assert.equal(r!.valid, true, JSON.stringify(r!.errors));
});

test("{§matcher-prefix-claims} PlurnkStatement: EDIT with an anchored line scope", () => {
    const r = validateRoundTrip("````EDIT (workspace:///meaning) <@aZ09b>\nThe meaning of life is 42\n````");
    assert.equal(r!.valid, true, JSON.stringify(r!.errors));
});

test("{§op-shapes} PlurnkStatement: COPY with destination resource selection", () => {
    const r = validateRoundTrip("````COPY (workspace:///draft) (workspace:///archive/draft)````");
    assert.equal(r!.valid, true, JSON.stringify(r!.errors));
});

test("{§op-shapes} PlurnkStatement: MOVE with destination resource selection", () => {
    const r = validateRoundTrip("````MOVE (workspace:///draft) (workspace:///final)````");
    assert.equal(r!.valid, true, JSON.stringify(r!.errors));
});

test("{§op-shapes} PlurnkStatement: SEND with JSON body", () => {
    const r = validateRoundTrip("````SEND\n{\"answer\":\"Paris\"}\n````\n````WAIT\n````");
    assert.equal(r!.valid, true, JSON.stringify(r!.errors));
});

test("{§op-shapes} PlurnkStatement: SEND with plain text body", () => {
    const r = validateRoundTrip("````NOTE\nstill working\n````");
    assert.equal(r!.valid, true, JSON.stringify(r!.errors));
});

test("{§op-shapes} PlurnkStatement: an execution with a runtime target and code body", () => {
    const r = validateRoundTrip("````sh (node/./)\nconsole.log(1)\n````");
    assert.equal(r!.valid, true, JSON.stringify(r!.errors));
});

test("{§op-shapes} PlurnkStatement: BARE carries inline or resource prompt input, but no scope", () => {
    const parsed = validateRoundTrip("````BARE\nWhat is the capital of Germany?\n````");
    assert.equal(parsed!.valid, true, JSON.stringify(parsed!.errors));

    const missing = baseFields("BARE");
    assert.equal(Validator.validatePlurnkStatement(missing).valid, false);
    assert.equal(Validator.validatePlurnkStatement({ ...missing, body: "prompt" }).valid, true);
    assert.equal(Validator.validatePlurnkStatement({ ...missing, body: "prompt", target: { kind: "local", raw: "prompt.md" } }).valid, true);
    const resource = validateRoundTrip("````BARE (session://alice/prompt.md)````");
    assert.equal(resource!.valid, true, JSON.stringify(resource!.errors));
    assert.equal(Validator.validatePlurnkStatement({ ...missing, body: "prompt", lineMarker: { marks: [1] } }).valid, false);
});

test("{§matcher-prefix-claims} PlurnkStatement parser preserves a decimal marker for runtime validation", () => {
    const r = validateRoundTrip("````EDIT (workspace:///checklist.md) <2.5>\n- [ ] new step\n````");
    assert.equal(r!.valid, true, JSON.stringify(r!.errors));
});

test("{§slot-order} PlurnkStatement: WAIT retains its literal body", () => {
    const parsed = PlurnkParser.parseStatements("````WAIT\nDecompose the prompt; discover, record, deliver.\n````");
    const item = parsed.items.find((candidate) => candidate.kind === "statement");
    assert.ok(item?.kind === "statement" && item.statement.op === "WAIT");
    assert.equal(item.statement.body, "Decompose the prompt; discover, record, deliver.");
    assert.equal(Validator.validatePlurnkStatement(item.statement).valid, true);
});

test("{§op-shapes} PlurnkStatement: KILL with bare target", () => {
    const r = validateRoundTrip("````KILL (sh:///3/1/2)````");
    assert.equal(r!.valid, true, JSON.stringify(r!.errors));
});

test("{§parse-recovery} PlurnkStatement: resource KILL's body warning does not prohibit log distillation", () => {
    const r = validateRoundTrip("````KILL (sh:///3/1/2) <!-- runaway; no output for 4 turns -->````");
    assert.equal(r!.valid, true, JSON.stringify(r!.errors));
    const ignored = PlurnkParser.parseStatements("````KILL (sh:///3/1/2)\nrunaway; no output for 4 turns\n````");
    assert.equal(ignored.items[0]?.kind, "statement", "the KILL still parses without its body");
    assert.ok(ignored.items.some((item) => item.kind === "error" && item.error.severity === "warning" && /This KILL takes no body/u.test(item.error.message)));
    const completion = PlurnkParser.parseStatements("````KILL (log:///1/2/3/READ)\nThe retained finding.\n````");
    assert.equal(completion.items.length, 1);
    const final = completion.items[0];
    assert.ok(final?.kind === "statement" && final.statement.op === "KILL");
    assert.equal(final.statement.body, "The retained finding.");
    const empty = PlurnkParser.parseStatements("````KILL (notes.md)\n\n````");
    assert.equal(empty.items.length, 1, "an empty targeted body remains valid without an advisory");
});

test("{§op-shapes} PlurnkStatement: WORK and FORK require prompt bodies", () => {
    for (const op of ["WORK", "FORK"]) {
        const missing = baseFields(op);
        assert.equal(Validator.validatePlurnkStatement(missing).valid, false);
        assert.equal(Validator.validatePlurnkStatement({ ...missing, body: "Do the assigned work" }).valid, true);
    }
});

// -------------------------------------------------------------------------
// Per-op shape constraints — hand-crafted fixtures
// -------------------------------------------------------------------------

// The text and log operations carry a `matcher` beside the shared slots ({§parse-recovery}).
const MATCHER_OPS = new Set(["FIND", "READ", "EDIT", "KILL"]);
const baseFields = (op: string) => ({
    op,
    aside: null,
    target: null,
    metadata: null,
    lineMarker: null,
    ...(MATCHER_OPS.has(op) ? { matcher: null } : {}),
    ...(op === "WAIT" ? { seconds: null } : {}),
    body: null,
    position: { line: 1, column: 0 },
});

// An execution has no op: its fence name is the runtime.
const execFields = () => ({
    runtime: "sh",
    aside: null,
    target: null,
    metadata: null,
    lineMarker: null,
    body: null,
    position: { line: 1, column: 0 },
});

const transferFields = (op: "COPY" | "MOVE") => ({
    op,
    aside: null,
    source: { target: parsePath("source")!, metadata: null, lineMarker: null, matcher: null },
    destination: { target: parsePath("destination")!, metadata: null, lineMarker: null, matcher: null },
    position: { line: 1, column: 0 },
});

test("{§op-shapes} PlurnkStatement: structured WAIT carries its duration separately from resource scopes", () => {
    const stmt = { ...baseFields("WAIT"), body: null, seconds: 30 };
    const { valid, errors } = Validator.validatePlurnkStatement(stmt);
    assert.equal(valid, true, JSON.stringify(errors));
});

test("{§op-shapes} PlurnkStatement: an execution accepts a lineMarker (timeout,poll)", () => {
    const stmt = { ...execFields(), runtime: "js", target: { kind: "local", raw: "tool.py" }, lineMarker: { marks: [60, 5] } };
    const { valid } = Validator.validatePlurnkStatement(stmt);
    assert.equal(valid, true);
});

test("{§op-shapes} PlurnkStatement: WAIT accepts an optional resource target but no metadata or lifecycle status", () => {
    const task = { ...baseFields("WAIT"), body: null };
    assert.equal(Validator.validatePlurnkStatement(task).valid, true);
    assert.equal(Validator.validatePlurnkStatement({ ...task, seconds: 0 }).valid, true);
    for (const address of ["notes.md", "session://child", "schedule:///rules/reminder"]) {
        const { valid, errors } = Validator.validatePlurnkStatement({ ...task, target: parsePath(address) });
        assert.equal(valid, true, JSON.stringify(errors));
    }
    for (const patch of [
        { target: "schedule:///rules/reminder" },
        { metadata: ["x: y"] },
        { status: 200 },
        { lineMarker: { marks: [1] } },
        { seconds: -1 },
    ]) {
        const { valid } = Validator.validatePlurnkStatement({ ...task, ...patch });
        assert.equal(valid, false, JSON.stringify(patch));
    }
});

test("{§matcher-prefix-claims} PlurnkStatement: FIND accepts lineMarker", () => {
    const stmt = { ...baseFields("FIND"), lineMarker: { marks: [1, 10] } };
    const { valid, errors } = Validator.validatePlurnkStatement(stmt);
    assert.equal(valid, true, JSON.stringify(errors));
});

test("{§op-shapes} PlurnkStatement: COPY requires exactly two resource selections and no body", () => {
    const statement = transferFields("COPY");
    assert.equal(Validator.validatePlurnkStatement(statement).valid, true);
    const { destination: _destination, ...missingDestination } = statement;
    assert.equal(Validator.validatePlurnkStatement(missingDestination).valid, false);
    assert.equal(Validator.validatePlurnkStatement({ ...statement, body: "destination" }).valid, false);
});

test("{§op-shapes} PlurnkStatement: COPY operands independently accept metadata and text scope", () => {
    const stmt = {
        ...transferFields("COPY"),
        source: {
            target: parsePath("session://draft/source")!,
            metadata: ["source metadata"],
            lineMarker: { marks: [1, 4] },
            matcher: { dialect: "glob", raw: "needle" },
        },
        destination: {
            target: {
                kind: "url",
                raw: "session://archive/draft",
                scheme: "session",
                username: null,
                password: null,
                hostname: "archive",
                port: null,
                pathname: "/draft",
                query: null,
                fragment: null,
            },
            metadata: ["destination metadata"],
            lineMarker: { marks: [12, 5, 12, 5] },
            matcher: null,
        },
    };
    const { valid, errors } = Validator.validatePlurnkStatement(stmt);
    assert.equal(valid, true, JSON.stringify(errors));
});

test("{§op-shapes} PlurnkStatement: SEND body must be SendBody shape (raw + json)", () => {
    const stmt = { ...baseFields("SEND"), body: "just a string" };
    const { valid } = Validator.validatePlurnkStatement(stmt);
    assert.equal(valid, false);
});

test("{§op-shapes} PlurnkStatement: EDIT body is a plain string", () => {
    const stmt = { ...baseFields("EDIT"), body: "some markdown content" };
    const { valid, errors } = Validator.validatePlurnkStatement(stmt);
    assert.equal(valid, true, JSON.stringify(errors));
});

test("{§parse-recovery} PlurnkStatement: EDIT rejects MatcherBody-shaped body", () => {
    const stmt = { ...baseFields("EDIT"), body: { dialect: "glob", raw: "*.xml" } };
    const { valid } = Validator.validatePlurnkStatement(stmt);
    assert.equal(valid, false);
});

test("{§whitespace-contract} PlurnkStatement: rejects unknown op", () => {
    const stmt = { ...baseFields("DROP") };
    const { valid } = Validator.validatePlurnkStatement(stmt);
    assert.equal(valid, false);
});

test("{§contract-representations} PlurnkStatement: rejects missing required field", () => {
    const stmt: Record<string, unknown> = baseFields("EDIT");
    delete stmt.position;
    const { valid } = Validator.validatePlurnkStatement(stmt);
    assert.equal(valid, false);
});

test("{§contract-representations} PlurnkStatement: rejects extra property", () => {
    const stmt: Record<string, unknown> = { ...baseFields("EDIT"), surprise: "field" };
    const { valid } = Validator.validatePlurnkStatement(stmt);
    assert.equal(valid, false);
});

// -------------------------------------------------------------------------
// Slot-order permutations round-trip
// -------------------------------------------------------------------------

test("{§slot-order} PlurnkStatement: round-trip survives slot-order permutation (path-first)", () => {
    const r = validateRoundTrip("````FIND (workspace:///docs) <1> @*.xml````");
    assert.equal(r!.valid, true, JSON.stringify(r!.errors));
});

test("{§slot-order} PlurnkStatement: round-trip survives slot-order permutation (L-first)", () => {
    const r = validateRoundTrip("````FIND <1-5> (workspace:///docs) @*.xml````");
    assert.equal(r!.valid, true, JSON.stringify(r!.errors));
});
});
