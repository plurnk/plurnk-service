import test from "node:test";
import assert from "node:assert/strict";
import Validator from "../../src/Validator.ts";
import { PlurnkParser } from "../../src/index.ts";

const validateRoundTrip = (input: string) => {
    const result = PlurnkParser.parse(input);
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
    const r = validateRoundTrip("<<FIND[a,b](known://docs)<1-20>:*.xml:FIND");
    assert.equal(r!.valid, true, JSON.stringify(r!.errors));
});

test("PlurnkStatement: READ with bare local path and empty body", () => {
    const r = validateRoundTrip("<<READ(config/foo.json)::READ");
    assert.equal(r!.valid, true, JSON.stringify(r!.errors));
});

test("PlurnkStatement: SHOW with regex matcher", () => {
    const r = validateRoundTrip("<<SHOW(known://**):/error|fail/i:SHOW");
    assert.equal(r!.valid, true, JSON.stringify(r!.errors));
});

test("PlurnkStatement: HIDE with jsonpath matcher", () => {
    const r = validateRoundTrip("<<HIDE(log://**):$.status:HIDE");
    assert.equal(r!.valid, true, JSON.stringify(r!.errors));
});

test("PlurnkStatement: EDIT with raw markdown body", () => {
    const r = validateRoundTrip("<<EDIT[philosophy](known://meaning):The meaning of life is 42:EDIT");
    assert.equal(r!.valid, true, JSON.stringify(r!.errors));
});

test("PlurnkStatement: COPY with path body", () => {
    const r = validateRoundTrip("<<COPY[archive](known://draft):known://archive/draft:COPY");
    assert.equal(r!.valid, true, JSON.stringify(r!.errors));
});

test("PlurnkStatement: MOVE with path body", () => {
    const r = validateRoundTrip("<<MOVE(known://draft):known://final:MOVE");
    assert.equal(r!.valid, true, JSON.stringify(r!.errors));
});

test("PlurnkStatement: SEND with integer signal and JSON body", () => {
    const r = validateRoundTrip('<<SEND[200]:{"answer":"Paris"}:SEND');
    assert.equal(r!.valid, true, JSON.stringify(r!.errors));
});

test("PlurnkStatement: SEND with plain text body", () => {
    const r = validateRoundTrip("<<SEND[102]:still working:SEND");
    assert.equal(r!.valid, true, JSON.stringify(r!.errors));
});

test("PlurnkStatement: EXEC with executor and code body", () => {
    const r = validateRoundTrip("<<EXEC[node](./):console.log(1):EXEC");
    assert.equal(r!.valid, true, JSON.stringify(r!.errors));
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

test("PlurnkStatement: SEND rejects non-null lineMarker", () => {
    const stmt = { ...baseFields("SEND"), signal: 200, lineMarker: { first: 1, last: null } };
    const { valid } = Validator.validatePlurnkStatement(stmt);
    assert.equal(valid, false);
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

test("PlurnkStatement: EXEC rejects non-null lineMarker", () => {
    const stmt = { ...baseFields("EXEC"), signal: "node", lineMarker: { first: 1, last: null } };
    const { valid } = Validator.validatePlurnkStatement(stmt);
    assert.equal(valid, false);
});

test("PlurnkStatement: FIND rejects numeric signal", () => {
    const stmt = { ...baseFields("FIND"), signal: 42 };
    const { valid } = Validator.validatePlurnkStatement(stmt);
    assert.equal(valid, false);
});

test("PlurnkStatement: FIND accepts lineMarker", () => {
    const stmt = { ...baseFields("FIND"), lineMarker: { first: 1, last: 10 } };
    const { valid, errors } = Validator.validatePlurnkStatement(stmt);
    assert.equal(valid, true, JSON.stringify(errors));
});

test("PlurnkStatement: COPY body must be ParsedPath shape", () => {
    const stmt = { ...baseFields("COPY"), body: { wrong: "shape" } };
    const { valid } = Validator.validatePlurnkStatement(stmt);
    assert.equal(valid, false);
});

test("PlurnkStatement: COPY body accepts valid local path", () => {
    const stmt = { ...baseFields("COPY"), body: { kind: "local", raw: "destination/path" } };
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
    const r = validateRoundTrip("<<FIND(known://docs)[a,b]<1>:*.xml:FIND");
    assert.equal(r!.valid, true, JSON.stringify(r!.errors));
});

test("PlurnkStatement: round-trip survives slot-order permutation (L-first)", () => {
    const r = validateRoundTrip("<<FIND<1-5>[a](known://docs):*.xml:FIND");
    assert.equal(r!.valid, true, JSON.stringify(r!.errors));
});
