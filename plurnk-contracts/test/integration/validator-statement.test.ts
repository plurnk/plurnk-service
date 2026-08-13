import test from "node:test";
import assert from "node:assert/strict";
import Validator from "../../src/Validator.ts";
import { PlurnkParser } from "../../src/index.ts";

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

test("PlurnkStatement: FIND with tag CSV, path, line marker, matcher", () => {
    const r = validateRoundTrip("## FIND0 [+a,+b] (known://docs) <1-20>\n*.xml");
    assert.equal(r!.valid, true, JSON.stringify(r!.errors));
});

test("PlurnkStatement: READ with bare local path and empty body", () => {
    const r = validateRoundTrip("## READ0 (config/foo.json)");
    assert.equal(r!.valid, true, JSON.stringify(r!.errors));
});

test("PlurnkStatement: OPEN with regex matcher", () => {
    const r = validateRoundTrip("## OPEN0 (known://**)\n/error|fail/i");
    assert.equal(r!.valid, true, JSON.stringify(r!.errors));
});

test("PlurnkStatement: FOLD with jsonpath matcher", () => {
    const r = validateRoundTrip("## FOLD0 (log://**)\n$.status");
    assert.equal(r!.valid, true, JSON.stringify(r!.errors));
});

test("PlurnkStatement: OPEN and FOLD have no positional line marker", () => {
    for (const op of ["OPEN", "FOLD"] as const) {
        const parsed = PlurnkParser.parseStatements(`## ${op}0 [memory] (log://**)`);
        const item = parsed.items[0];
        assert.equal(item.kind, "statement");
        if (item.kind !== "statement") continue;
        assert.equal(item.statement.op, op);
        assert.equal(item.statement.lineMarker, null);

        const invalid = Validator.validatePlurnkStatement({
            ...JSON.parse(JSON.stringify(item.statement)),
            lineMarker: { marks: [1] },
        });
        assert.equal(invalid.valid, false, `${op} schema must reject a positional line marker`);
        assert.ok(invalid.errors.some(({ instanceLocation }) => instanceLocation.endsWith("/lineMarker")));
    }
});

test("PlurnkStatement: EDIT with raw markdown body", () => {
    const r = validateRoundTrip("## EDIT0 [+philosophy] (known://meaning)\nThe meaning of life is 42");
    assert.equal(r!.valid, true, JSON.stringify(r!.errors));
});

test("PlurnkStatement: EDIT with an anchored line scope", () => {
    const r = validateRoundTrip("## EDIT0 (known://meaning) <@aZ09b>\nThe meaning of life is 42");
    assert.equal(r!.valid, true, JSON.stringify(r!.errors));
});

test("PlurnkStatement: COPY with destination resource selection", () => {
    const r = validateRoundTrip("## COPY0 [+archive] (known://draft)\nknown://archive/draft");
    assert.equal(r!.valid, true, JSON.stringify(r!.errors));
});

test("PlurnkStatement: MOVE with destination resource selection", () => {
    const r = validateRoundTrip("## MOVE0 (known://draft)\nknown://final");
    assert.equal(r!.valid, true, JSON.stringify(r!.errors));
});

test("PlurnkStatement: SEND with integer signal and JSON body", () => {
    const r = validateRoundTrip('## SEND0 [200]\n{"answer":"Paris"}');
    assert.equal(r!.valid, true, JSON.stringify(r!.errors));
});

test("PlurnkStatement: SEND with plain text body", () => {
    const r = validateRoundTrip("## SEND0 [102]\nstill working");
    assert.equal(r!.valid, true, JSON.stringify(r!.errors));
});

test("PlurnkStatement: EXEC with executor and code body", () => {
    const r = validateRoundTrip("## EXEC0 [node] (./)\nconsole.log(1)");
    assert.equal(r!.valid, true, JSON.stringify(r!.errors));
});

test("PlurnkStatement parser preserves a decimal marker for runtime validation", () => {
    const r = validateRoundTrip("## EDIT0 (known://plan) <2.5>\n- [ ] new step");
    assert.equal(r!.valid, true, JSON.stringify(r!.errors));
});

test("PlurnkStatement: FIND with decimal threshold and semantic matcher", () => {
    const r = validateRoundTrip("## FIND0 (known://**) <0.7>\n~territorial concessions");
    assert.equal(r!.valid, true, JSON.stringify(r!.errors));
});

test("PlurnkStatement: FIND with threshold-prefixed result range", () => {
    const r = validateRoundTrip("## FIND0 (known://**) <0.7,10,20>\n~concessions");
    assert.equal(r!.valid, true, JSON.stringify(r!.errors));
});

test("PlurnkStatement: PLAN with bare intended-goals body", () => {
    const r = validateRoundTrip("# PLAN0\nDecompose the prompt; discover, record, deliver.");
    assert.equal(r!.valid, true, JSON.stringify(r!.errors));
});

test("PlurnkStatement: PLAN with tags (parse-side permissive)", () => {
    const r = validateRoundTrip("# PLAN0 [france,strategy]\nCapital fact first, then deliver.");
    assert.equal(r!.valid, true, JSON.stringify(r!.errors));
});

test("PlurnkStatement: KILL with bare target", () => {
    const r = validateRoundTrip("## KILL0 (sh:///3/1/2)");
    assert.equal(r!.valid, true, JSON.stringify(r!.errors));
});

test("PlurnkStatement: KILL with signal and annotation body", () => {
    const r = validateRoundTrip("## KILL0 [9] (sh:///3/1/2)\nrunaway; no output for 4 turns");
    assert.equal(r!.valid, true, JSON.stringify(r!.errors));
});

test("PlurnkStatement: WORK and FORK require prompt bodies", () => {
    for (const op of ["WORK", "FORK"]) {
        const missing = baseFields(op);
        assert.equal(Validator.validatePlurnkStatement(missing).valid, false);
        assert.equal(Validator.validatePlurnkStatement({ ...missing, body: "Do the assigned work" }).valid, true);
    }
});

// -------------------------------------------------------------------------
// Per-op shape constraints — hand-crafted fixtures
// -------------------------------------------------------------------------

const baseFields = (op: string) => ({
    op,
    suffix: "",
    signal: null,
    target: null,
    lineMarker: null,
    body: null,
    position: { line: 1, column: 0 },
});

test("PlurnkStatement: SEND rejects array signal", () => {
    const stmt = { ...baseFields("SEND"), signal: ["a", "b"] };
    const { valid } = Validator.validatePlurnkStatement(stmt);
    assert.equal(valid, false);
});

test("PlurnkStatement: SEND rejects string signal", () => {
    const stmt = { ...baseFields("SEND"), signal: "abc" };
    const { valid } = Validator.validatePlurnkStatement(stmt);
    assert.equal(valid, false);
});

test("PlurnkStatement: SEND accepts a terminal wait scope", () => {
    const stmt = { ...baseFields("SEND"), signal: 202, lineMarker: { marks: [30] } };
    const { valid, errors } = Validator.validatePlurnkStatement(stmt);
    assert.equal(valid, true, JSON.stringify(errors));
});

test("PlurnkStatement: EXEC rejects array signal", () => {
    const stmt = { ...baseFields("EXEC"), signal: ["node"] };
    const { valid } = Validator.validatePlurnkStatement(stmt);
    assert.equal(valid, false);
});

test("PlurnkStatement: EXEC rejects numeric signal", () => {
    const stmt = { ...baseFields("EXEC"), signal: 200 };
    const { valid } = Validator.validatePlurnkStatement(stmt);
    assert.equal(valid, false);
});

test("PlurnkStatement: EXEC accepts a lineMarker (timeout,poll)", () => {
    const stmt = { ...baseFields("EXEC"), signal: "node", lineMarker: { marks: [60, 5] } };
    const { valid } = Validator.validatePlurnkStatement(stmt);
    assert.equal(valid, true);
});

test("PlurnkStatement: PLAN rejects numeric signal", () => {
    const stmt = { ...baseFields("PLAN"), signal: 42 };
    const { valid } = Validator.validatePlurnkStatement(stmt);
    assert.equal(valid, false);
});

test("PlurnkStatement: KILL rejects string signal", () => {
    const stmt = { ...baseFields("KILL"), signal: "TERM" };
    const { valid } = Validator.validatePlurnkStatement(stmt);
    assert.equal(valid, false);
});

test("PlurnkStatement: KILL rejects non-null lineMarker", () => {
    const stmt = { ...baseFields("KILL"), signal: 9, lineMarker: { marks: [1] } };
    const { valid } = Validator.validatePlurnkStatement(stmt);
    assert.equal(valid, false);
});

test("PlurnkStatement: FIND rejects numeric signal", () => {
    const stmt = { ...baseFields("FIND"), signal: 42 };
    const { valid } = Validator.validatePlurnkStatement(stmt);
    assert.equal(valid, false);
});

test("PlurnkStatement: classifying and curation tag terms retain distinct wire shapes", () => {
    for (const op of ["FIND", "READ", "EDIT", "COPY", "MOVE"] as const) {
        assert.equal(Validator.validatePlurnkStatement({ ...baseFields(op), signal: ["+research"] }).valid, true, op);
        assert.equal(Validator.validatePlurnkStatement({ ...baseFields(op), signal: ["research"] }).valid, true, op);
        assert.equal(Validator.validatePlurnkStatement({ ...baseFields(op), signal: ["-research"] }).valid, false, op);
    }
    for (const op of ["FOLD", "OPEN"] as const) {
        assert.equal(
            Validator.validatePlurnkStatement({ ...baseFields(op), signal: ["research", "+archive", "-stale"] }).valid,
            true,
            op,
        );
    }
});

test("PlurnkStatement: FIND accepts lineMarker", () => {
    const stmt = { ...baseFields("FIND"), lineMarker: { marks: [1, 10] } };
    const { valid, errors } = Validator.validatePlurnkStatement(stmt);
    assert.equal(valid, true, JSON.stringify(errors));
});

test("PlurnkStatement: COPY body requires a resource selection", () => {
    const stmt = { ...baseFields("COPY"), body: { kind: "local", raw: "destination/path" } };
    const { valid } = Validator.validatePlurnkStatement(stmt);
    assert.equal(valid, false);
});

test("PlurnkStatement: COPY destination body accepts a scoped resource", () => {
    const stmt = {
        ...baseFields("COPY"),
        body: {
            target: {
                kind: "url",
                raw: "known://archive/draft",
                scheme: "known",
                username: null,
                password: null,
                hostname: "archive",
                port: null,
                pathname: "/draft",
                query: null,
                fragment: null,
            },
            lineMarker: { marks: [12, 5, 12, 5] },
        },
    };
    const { valid, errors } = Validator.validatePlurnkStatement(stmt);
    assert.equal(valid, true, JSON.stringify(errors));
});

test("PlurnkStatement: SEND body must be SendBody shape (raw + json)", () => {
    const stmt = { ...baseFields("SEND"), signal: 200, body: "just a string" };
    const { valid } = Validator.validatePlurnkStatement(stmt);
    assert.equal(valid, false);
});

test("PlurnkStatement: EDIT body is a plain string", () => {
    const stmt = { ...baseFields("EDIT"), body: "some markdown content" };
    const { valid, errors } = Validator.validatePlurnkStatement(stmt);
    assert.equal(valid, true, JSON.stringify(errors));
});

test("PlurnkStatement: EDIT rejects MatcherBody-shaped body", () => {
    const stmt = { ...baseFields("EDIT"), body: { dialect: "glob", raw: "*.xml" } };
    const { valid } = Validator.validatePlurnkStatement(stmt);
    assert.equal(valid, false);
});

test("PlurnkStatement: rejects unknown op", () => {
    const stmt = { ...baseFields("DROP") };
    const { valid } = Validator.validatePlurnkStatement(stmt);
    assert.equal(valid, false);
});

test("PlurnkStatement: rejects missing required field", () => {
    const stmt: any = baseFields("EDIT");
    delete stmt.position;
    const { valid } = Validator.validatePlurnkStatement(stmt);
    assert.equal(valid, false);
});

test("PlurnkStatement: rejects extra property", () => {
    const stmt: any = { ...baseFields("EDIT"), surprise: "field" };
    const { valid } = Validator.validatePlurnkStatement(stmt);
    assert.equal(valid, false);
});

// -------------------------------------------------------------------------
// Slot-order permutations round-trip
// -------------------------------------------------------------------------

test("PlurnkStatement: round-trip survives slot-order permutation (path-first)", () => {
    const r = validateRoundTrip("## FIND0 (known://docs) [+a,+b] <1>\n*.xml");
    assert.equal(r!.valid, true, JSON.stringify(r!.errors));
});

test("PlurnkStatement: round-trip survives slot-order permutation (L-first)", () => {
    const r = validateRoundTrip("## FIND0 <1-5> [+a] (known://docs)\n*.xml");
    assert.equal(r!.valid, true, JSON.stringify(r!.errors));
});
