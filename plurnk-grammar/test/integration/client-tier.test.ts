import test from "node:test";
import assert from "node:assert/strict";
import { PlurnkParser, Validator } from "../../src/index.ts";

const clientStatementsOf = (input: string) =>
    PlurnkParser.parseClient(input).items.filter((i) => i.kind === "statement");

// -------------------------------------------------------------------------
// parseClient admits LOOK / BUFF (read-shaped) and protocol statements
// -------------------------------------------------------------------------

test("client: parseClient parses a bare LOOK", () => {
    const stmts = clientStatementsOf("<<LOOK(known://philosophy/meaning)::LOOK");
    assert.equal(stmts.length, 1);
    assert.equal(stmts[0].statement.op, "LOOK");
});

test("client: parseClient parses a bare BUFF", () => {
    const stmts = clientStatementsOf("<<BUFF(known://drafts/letter)::BUFF");
    assert.equal(stmts.length, 1);
    assert.equal(stmts[0].statement.op, "BUFF");
});

test("client: parseClient admits protocol statements alongside client ops", () => {
    const input = "<<READ(known://a)::READ <<LOOK(known://b)::LOOK <<BUFF(known://c)::BUFF";
    const ops = clientStatementsOf(input).map((i) => i.statement.op);
    assert.deepEqual(ops, ["READ", "LOOK", "BUFF"]);
});

test("client: LOOK is read-shaped — tag signal, target, lineMarker, matcher body", () => {
    const stmts = clientStatementsOf("<<LOOK[draft](known://notes)<1-20>:~recent thoughts:LOOK");
    assert.equal(stmts.length, 1);
    const s: any = stmts[0].statement;
    assert.equal(s.op, "LOOK");
    assert.deepEqual(s.signal, ["draft"]);
    assert.equal(s.target.scheme, "known");
    assert.deepEqual(s.lineMarker.marks, [1, 20]);
    assert.equal(s.body.dialect, "semantic");
});

test("client: BUFF carries a matcher body (filter on the way in)", () => {
    const stmts = clientStatementsOf("<<BUFF(file://draft.md):#TODO#i:BUFF");
    const s: any = stmts[0].statement;
    assert.equal(s.op, "BUFF");
    assert.equal(s.body.dialect, "regex");
    assert.equal(s.body.pattern, "TODO");
    assert.equal(s.body.flags, "i");
});

test("client: suffix nesting works on LOOK like any read op", () => {
    const stmts = clientStatementsOf("<<LOOK1(p):body mentions :LOOK inside:LOOK1");
    assert.equal(stmts.length, 1);
    assert.equal(stmts[0].statement.op, "LOOK");
    assert.equal(stmts[0].statement.suffix, "1");
});

// -------------------------------------------------------------------------
// Territorial integrity — client ops fail hard outside the client tier
// -------------------------------------------------------------------------

test("client: parseStatements (protocol) rejects LOOK", () => {
    const stmts = PlurnkParser.parseStatements("<<LOOK(p)::LOOK").items.filter((i) => i.kind === "statement");
    assert.equal(stmts.length, 0);
});

test("client: parseStatements (protocol) rejects BUFF", () => {
    const stmts = PlurnkParser.parseStatements("<<BUFF(p)::BUFF").items.filter((i) => i.kind === "statement");
    assert.equal(stmts.length, 0);
});

test("client: a LOOK mid-turn breaks parse() (not a protocol op)", () => {
    const input = "<<PLAN:think:PLAN <<LOOK(p)::LOOK <<SEND[200]:done:SEND";
    const result = PlurnkParser.parse(input);
    // The LOOK is not admissible mid-turn; the turn does not parse cleanly.
    const errors = result.items.filter((i) => i.kind === "error");
    assert.ok(errors.length > 0 || result.unparsedTail !== undefined);
});

test("client: an unknown <<word still stays prose (registry, not shape, governs)", () => {
    // MAGIC is not a minted op, so `<<MAGIC` is text — the forgiving layer is intact.
    const items = PlurnkParser.parseClient("<<MAGIC is not an op").items;
    assert.equal(items.filter((i) => i.kind === "statement").length, 0);
    assert.ok(items.some((i) => i.kind === "text"));
});

// -------------------------------------------------------------------------
// Validator — ClientStatement accepts client + protocol ops, rejects bad op
// -------------------------------------------------------------------------

test("Validator: ClientStatement accepts a LOOK statement", () => {
    const s = clientStatementsOf("<<LOOK(known://x):~q:LOOK")[0].statement;
    const { valid, errors } = Validator.validateClientStatement(s);
    assert.equal(valid, true, JSON.stringify(errors));
});

test("Validator: ClientStatement accepts a BUFF statement", () => {
    const s = clientStatementsOf("<<BUFF(known://x)::BUFF")[0].statement;
    const { valid, errors } = Validator.validateClientStatement(s);
    assert.equal(valid, true, JSON.stringify(errors));
});

test("Validator: ClientStatement accepts a protocol READ statement", () => {
    const s = PlurnkParser.parseStatements("<<READ(known://x)::READ").items
        .filter((i) => i.kind === "statement")[0].statement;
    const { valid, errors } = Validator.validateClientStatement(s);
    assert.equal(valid, true, JSON.stringify(errors));
});

test("Validator: ClientStatement rejects an unknown op", () => {
    const s = { op: "PEEK", suffix: "", signal: null, target: null, lineMarker: null, body: null, position: { line: 0, column: 0 } };
    const { valid } = Validator.validateClientStatement(s);
    assert.equal(valid, false);
});

test("Validator: protocol PlurnkStatement rejects a LOOK (client op stays out of the closed set)", () => {
    const s = clientStatementsOf("<<LOOK(known://x)::LOOK")[0].statement;
    const { valid } = Validator.validatePlurnkStatement(s);
    assert.equal(valid, false);
});
