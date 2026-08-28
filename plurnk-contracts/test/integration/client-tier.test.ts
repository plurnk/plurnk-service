import test from "node:test";
import assert from "node:assert/strict";
import { PlurnkParser, Validator } from "../../src/index.ts";

const clientStatementsOf = (input: string) =>
    PlurnkParser.parseClient(input).items.filter((i) => i.kind === "statement");

// -------------------------------------------------------------------------
// parseClient admits LOOK / BUFF (read-shaped) and protocol statements
// -------------------------------------------------------------------------

test("client: parseClient parses a bare LOOK", () => {
    const stmts = clientStatementsOf("## LOOK0 (known://philosophy/meaning)");
    assert.equal(stmts.length, 1);
    assert.equal(stmts[0].statement.op, "LOOK");
});

test("client: parseClient parses a bare BUFF", () => {
    const stmts = clientStatementsOf("## BUFF0 (known://drafts/letter)");
    assert.equal(stmts.length, 1);
    assert.equal(stmts[0].statement.op, "BUFF");
});

test("client: parseClient admits protocol statements alongside client ops", () => {
    const input = "## READ0 (known://a)\n\n## LOOK0 (known://b)\n\n## BUFF0 (known://c)";
    const ops = clientStatementsOf(input).map((i) => i.statement.op);
    assert.deepEqual(ops, ["READ", "LOOK", "BUFF"]);
});

test("client: LOOK is read-shaped — tag signal, target, lineMarker, matcher body", () => {
    const stmts = clientStatementsOf("## LOOK0 [draft] (known://notes) <1-20>\n~recent thoughts");
    assert.equal(stmts.length, 1);
    const s: any = stmts[0].statement;
    assert.equal(s.op, "LOOK");
    assert.deepEqual(s.signal, ["draft"]);
    assert.equal(s.target.scheme, "known");
    assert.deepEqual(s.lineMarker.marks, [1, 20]);
    assert.equal(s.body.dialect, "semantic");
});

test("client: LOOK accepts line anchors while BUFF result positions remain numeric", () => {
    const result = PlurnkParser.parseClient("## LOOK0 (worker:///notes.md) <@aZ09b>");
    const item = result.items.find((candidate) => candidate.kind === "statement");
    assert.equal(item?.kind, "statement");
    if (item?.kind !== "statement") return;
    assert.equal(item.statement.op, "LOOK");
    assert.deepEqual(item.statement.lineMarker, { marks: ["@aZ09b"] });

    const buff = PlurnkParser.parseClient("## BUFF0 (worker:///notes.md) <@aZ09b>");
    assert.ok(buff.items.some((candidate) => candidate.kind === "error"));
});

test("client: BUFF carries a matcher body (filter on the way in)", () => {
    const stmts = clientStatementsOf("## BUFF0 (file://draft.md)\n/TODO/i");
    const s: any = stmts[0].statement;
    assert.equal(s.op, "BUFF");
    assert.equal(s.body.dialect, "regex");
    assert.equal(s.body.pattern, "TODO");
    assert.equal(s.body.flags, "i");
});

test("client: LOOK and BUFF share single-line matcher admission", () => {
    for (const op of ["LOOK", "BUFF"] as const) {
        const result = PlurnkParser.parseClient(`## ${op}0 (known://notes)\nfirst line\nsecond line`);
        const errors = result.items.filter((item) => item.kind === "error");
        assert.equal(errors.length, 1, op);
        assert.equal(errors[0]?.error.source, "visitor", op);
        assert.equal(errors[0]?.error.message, "Matcher body has 2 lines; expected 1.", op);
        assert.equal(result.items.some((item) => item.kind === "statement"), false, op);
    }
});

// {§empty-section}
test("client: empty LOOK and BUFF sections normalize to null bodies", () => {
    for (const op of ["LOOK", "BUFF"] as const) {
        const statements = clientStatementsOf(`## ${op}0 (known://x)`);
        assert.equal(statements.length, 1, op);
        const statement = statements[0]?.statement;
        assert.equal(statement && "body" in statement ? statement.body : undefined, null, op);
    }
});

test("client: a different-lane LOOK heading remains body text and therefore violates the one-line matcher contract", () => {
    const result = PlurnkParser.parseClient("## LOOK0 (p)\nbody mentions\n\n## LOOK2 (nested)");
    assert.equal(result.items.some((item) => item.kind === "statement"), false);
    const errors = result.items.filter((item) => item.kind === "error");
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.error.message, "Matcher body has 3 lines; expected 1.");
});

// -------------------------------------------------------------------------
// Territorial integrity — client ops fail hard outside the client tier
// -------------------------------------------------------------------------

// {§tier-entrypoints}
test("client: parseStatements (protocol) rejects LOOK", () => {
    const stmts = PlurnkParser.parseStatements("## LOOK0 (p)").items.filter((i) => i.kind === "statement");
    assert.equal(stmts.length, 0);
});

test("client: parseStatements (protocol) rejects BUFF", () => {
    const stmts = PlurnkParser.parseStatements("## BUFF0 (p)").items.filter((i) => i.kind === "statement");
    assert.equal(stmts.length, 0);
});

test("client: a LOOK mid-turn breaks parse() (not a protocol op)", () => {
    const input = '# PLAN0\n[{"content":"think","status":"in_progress"}]\n## LOOK0 (p)\n## SEND0 [200]\ndone';
    const result = PlurnkParser.parse(input);
    // The LOOK is not admissible mid-turn; the turn does not parse cleanly.
    const errors = result.items.filter((i) => i.kind === "error");
    assert.ok(errors.length > 0 || result.unparsedTail !== undefined);
});

test("client: an unknown H2 word stays text because the registry governs operation identity", () => {
    const items = PlurnkParser.parseClient("## MAGIC0 is not an op").items;
    assert.equal(items.filter((i) => i.kind === "statement").length, 0);
    assert.ok(items.some((i) => i.kind === "text"));
});

// -------------------------------------------------------------------------
// Validator — ClientStatement accepts client + protocol ops, rejects bad op
// -------------------------------------------------------------------------

test("Validator: ClientStatement accepts a LOOK statement", () => {
    const s = clientStatementsOf("## LOOK0 (known://x)\n~q")[0].statement;
    const { valid, errors } = Validator.validateClientStatement(s);
    assert.equal(valid, true, JSON.stringify(errors));
});

test("Validator: ClientStatement accepts a BUFF statement", () => {
    const s = clientStatementsOf("## BUFF0 (known://x)")[0].statement;
    const { valid, errors } = Validator.validateClientStatement(s);
    assert.equal(valid, true, JSON.stringify(errors));
});

test("Validator: ClientStatement accepts a protocol READ statement", () => {
    const s = PlurnkParser.parseStatements("## READ0 (known://x)").items
        .filter((i) => i.kind === "statement")[0].statement;
    const { valid, errors } = Validator.validateClientStatement(s);
    assert.equal(valid, true, JSON.stringify(errors));
});

test("Validator: ClientStatement rejects an unknown op", () => {
    const s = { op: "PEEK", delimiter: "", signal: null, target: null, lineMarker: null, body: null, position: { line: 0, column: 0 } };
    const { valid } = Validator.validateClientStatement(s);
    assert.equal(valid, false);
});

test("Validator: protocol PlurnkStatement rejects a LOOK (client op stays out of the closed set)", () => {
    const s = clientStatementsOf("## LOOK0 (known://x)")[0].statement;
    const { valid } = Validator.validatePlurnkStatement(s);
    assert.equal(valid, false);
});
