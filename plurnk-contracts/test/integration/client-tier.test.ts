import test from "node:test";
import assert from "node:assert/strict";
import { PlurnkParser, Validator } from "../../src/index.ts";

const clientStatementsOf = (input: string) =>
    PlurnkParser.parseClient(input).items.filter((i) => i.kind === "statement");

// -------------------------------------------------------------------------
// parseClient admits LOOK (read-shaped) and protocol statements
// -------------------------------------------------------------------------

test("client: parseClient parses a bare LOOK", () => {
    const stmts = clientStatementsOf("```LOOK (known://philosophy/meaning)```");
    assert.equal(stmts.length, 1);
    assert.equal(stmts[0].statement.op, "LOOK");
});

test("client: parseClient admits protocol statements alongside client ops", () => {
    const input = "```READ (known://a)```\n```LOOK (known://b)```";
    const ops = clientStatementsOf(input).map((i) => i.statement.op);
    assert.deepEqual(ops, ["READ", "LOOK"]);
});

test("client: LOOK is read-shaped — target, lineMarker, matcher body", () => {
    const stmts = clientStatementsOf("```LOOK (known://notes) <1-20>\n~recent thoughts\n```");
    assert.equal(stmts.length, 1);
    const s: any = stmts[0].statement;
    assert.equal(s.op, "LOOK");
    assert.equal(s.target.scheme, "known");
    assert.deepEqual(s.lineMarker.marks, [1, 20]);
    assert.equal(s.body.dialect, "fts");
});

test("client: LOOK accepts line anchors", () => {
    const result = PlurnkParser.parseClient("```LOOK (worker:///notes.md) <@aZ09b>```");
    const item = result.items.find((candidate) => candidate.kind === "statement");
    assert.equal(item?.kind, "statement");
    if (item?.kind !== "statement") return;
    assert.equal(item.statement.op, "LOOK");
    assert.deepEqual(item.statement.lineMarker, { marks: ["@aZ09b"] });
});

// BUFF left the language with #625: a retired client op is an ordinary fence name, which the
// grammar reads as an executor tag, never as a client statement.
test("client: BUFF is no longer a client op, and an unknown tag opens nothing ({§interstitial-fence})", () => {
    const result = PlurnkParser.parseClient("```BUFF (known://drafts/letter)```");
    assert.deepEqual(result.items.filter((item) => item.kind === "statement"), []);
    assert.deepEqual(result.items.map((item) => item.kind === "error" ? [item.error.severity, item.error.line] : "statement"), [["warning", 1]]);
});

test("client: LOOK has single-line matcher admission", () => {
    for (const op of ["LOOK"] as const) {
        const result = PlurnkParser.parseClient(PlurnkParser.frame(`${op} (known://notes)`, "first line\nsecond line"));
        const errors = result.items.filter((item) => item.kind === "error");
        assert.equal(errors.length, 1, op);
        assert.equal(errors[0]?.error.source, "visitor", op);
        assert.equal(errors[0]?.error.message, "Matcher has 2 lines; expected 1.", op);
        assert.equal(result.items.some((item) => item.kind === "statement"), false, op);
    }
});

// {§empty-section}
test("client: an empty LOOK section normalizes to a null body", () => {
    for (const op of ["LOOK"] as const) {
        const statements = clientStatementsOf(PlurnkParser.frame(`${op} (known://x)`, null));
        assert.equal(statements.length, 1, op);
        const statement = statements[0]?.statement;
        assert.equal(statement && "body" in statement ? statement.body : undefined, null, op);
    }
});

test("client: a different-lane LOOK heading remains body text and therefore violates the one-line matcher contract", () => {
    const result = PlurnkParser.parseClient("```LOOK (p)\nbody mentions\n\n### LOOK2 (nested)\n```");
    assert.equal(result.items.some((item) => item.kind === "statement"), false);
    const errors = result.items.filter((item) => item.kind === "error");
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.error.message, "Matcher has 3 lines; expected 1.");
});

// -------------------------------------------------------------------------
// Territorial integrity — client ops fail hard outside the client tier
// -------------------------------------------------------------------------

// {§tier-entrypoints}
test("client: parseStatements (protocol) rejects LOOK", () => {
    const stmts = PlurnkParser.parseStatements("```LOOK (p)```").items.filter((i) => i.kind === "statement");
    assert.equal(stmts.length, 0);
});

test("client: parseStatements (protocol) reads a retired client op name as prose unless the host names it as an executor", () => {
    const prose = PlurnkParser.parseStatements("```BUFF (p)```");
    assert.deepEqual(prose.items.filter((i) => i.kind === "statement"), []);
    const named = PlurnkParser.parseStatements("```BUFF (p)```", { executors: ["BUFF"] }).items.filter((i) => i.kind === "statement");
    assert.equal(named.length, 1);
    assert.equal(named[0]?.kind === "statement" ? named[0].statement.op : null, "EXEC");
});

test("client: a LOOK mid-turn breaks parse() (not a protocol op)", () => {
    const input = "```LOOK (p)```\n```SEND\ndone\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```";
    const result = PlurnkParser.parse(input);
    // The LOOK is not admissible mid-turn; the turn does not parse cleanly.
    const errors = result.items.filter((i) => i.kind === "error");
    assert.ok(errors.length > 0 || result.unparsedTail !== undefined);
});

test("client: ordinary Markdown headings are ignored, not operations", () => {
    const items = PlurnkParser.parseClient("## MAGIC0 is not an op").items;
    assert.deepEqual(items, []);
});

// -------------------------------------------------------------------------
// Validator — ClientStatement accepts client + protocol ops, rejects bad op
// -------------------------------------------------------------------------

test("Validator: ClientStatement accepts a LOOK statement", () => {
    const s = clientStatementsOf("```LOOK (known://x)\n~q\n```")[0].statement;
    const { valid, errors } = Validator.validateClientStatement(s);
    assert.equal(valid, true, JSON.stringify(errors));
});

test("Validator: ClientStatement accepts a protocol READ statement", () => {
    const s = PlurnkParser.parseStatements("```READ (known://x)```").items
        .filter((i) => i.kind === "statement")[0].statement;
    const { valid, errors } = Validator.validateClientStatement(s);
    assert.equal(valid, true, JSON.stringify(errors));
});

test("Validator: ClientStatement rejects an unknown op", () => {
    const s = { op: "PEEK", target: null, lineMarker: null, body: null, position: { line: 0, column: 0 } };
    const { valid } = Validator.validateClientStatement(s);
    assert.equal(valid, false);
});

test("Validator: protocol PlurnkStatement rejects a LOOK (client op stays out of the closed set)", () => {
    const s = clientStatementsOf("```LOOK (known://x)```")[0].statement;
    const { valid } = Validator.validatePlurnkStatement(s);
    assert.equal(valid, false);
});
