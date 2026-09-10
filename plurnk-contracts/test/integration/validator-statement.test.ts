import test from "node:test";
import assert from "node:assert/strict";
import Validator from "../../src/Validator.ts";
import { parsePath, PlurnkParser } from "../../src/index.ts";

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
    const r = validateRoundTrip("```FIND (known://docs) <1-20>\n*.xml\n```");
    assert.equal(r!.valid, true, JSON.stringify(r!.errors));
});

test("PlurnkStatement: READ with bare local path and empty body", () => {
    const r = validateRoundTrip("```READ (config/foo.json)```");
    assert.equal(r!.valid, true, JSON.stringify(r!.errors));
});

test("PlurnkStatement: KILL with regex matcher", () => {
    const r = validateRoundTrip("```KILL (known://**)\n/error|fail/i\n```");
    assert.equal(r!.valid, true, JSON.stringify(r!.errors));
});

test("PlurnkStatement: KILL with jsonpath matcher", () => {
    const r = validateRoundTrip("```KILL (log://**)\n$.status\n```");
    assert.equal(r!.valid, true, JSON.stringify(r!.errors));
});

test("PlurnkStatement: KILL admits log-body line markers", () => {
    const parsed = PlurnkParser.parseStatements("```KILL (log://**) <17,-1>```");
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

test("PlurnkStatement: EDIT with raw markdown body", () => {
    const r = validateRoundTrip("```EDIT (known://meaning)\nThe meaning of life is 42\n```");
    assert.equal(r!.valid, true, JSON.stringify(r!.errors));
});

test("PlurnkStatement: EDIT with an anchored line scope", () => {
    const r = validateRoundTrip("```EDIT (known://meaning) <@aZ09b>\nThe meaning of life is 42\n```");
    assert.equal(r!.valid, true, JSON.stringify(r!.errors));
});

test("PlurnkStatement: COPY with destination resource selection", () => {
    const r = validateRoundTrip("```COPY (known://draft) (known://archive/draft)```");
    assert.equal(r!.valid, true, JSON.stringify(r!.errors));
});

test("PlurnkStatement: MOVE with destination resource selection", () => {
    const r = validateRoundTrip("```MOVE (known://draft) (known://final)```");
    assert.equal(r!.valid, true, JSON.stringify(r!.errors));
});

test("PlurnkStatement: SEND with integer signal and JSON body", () => {
    const r = validateRoundTrip("```SEND\n{\"answer\":\"Paris\"}\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```");
    assert.equal(r!.valid, true, JSON.stringify(r!.errors));
});

test("PlurnkStatement: SEND with plain text body", () => {
    const r = validateRoundTrip("```TASK\n[{\"content\":\"still working\",\"status\":\"in_progress\"}]\n```");
    assert.equal(r!.valid, true, JSON.stringify(r!.errors));
});

test("PlurnkStatement: EXEC with executor and code body", () => {
    const r = validateRoundTrip("```EXEC (node/./)\nconsole.log(1)\n```");
    assert.equal(r!.valid, true, JSON.stringify(r!.errors));
});

// {§bare-statement}
test("PlurnkStatement: BARE carries inline or resource prompt input, but no scope", () => {
    const parsed = validateRoundTrip("```BARE\nWhat is the capital of Germany?\n```");
    assert.equal(parsed!.valid, true, JSON.stringify(parsed!.errors));

    const missing = baseFields("BARE");
    assert.equal(Validator.validatePlurnkStatement(missing).valid, false);
    assert.equal(Validator.validatePlurnkStatement({ ...missing, body: "prompt" }).valid, true);
    assert.equal(Validator.validatePlurnkStatement({ ...missing, body: "prompt", target: { kind: "local", raw: "prompt.md" } }).valid, true);
    const resource = validateRoundTrip("```BARE (worker://alice/prompt.md)```");
    assert.equal(resource!.valid, true, JSON.stringify(resource!.errors));
    assert.equal(Validator.validatePlurnkStatement({ ...missing, body: "prompt", lineMarker: { marks: [1] } }).valid, false);
});

test("PlurnkStatement parser preserves a decimal marker for runtime validation", () => {
    const r = validateRoundTrip("```EDIT (known://plan) <2.5>\n- [ ] new step\n```");
    assert.equal(r!.valid, true, JSON.stringify(r!.errors));
});

test("PlurnkStatement: FIND with decimal threshold and semantic matcher", () => {
    const r = validateRoundTrip("```FIND (known://**) <0.7>\n~territorial concessions\n```");
    assert.equal(r!.valid, true, JSON.stringify(r!.errors));
});

test("PlurnkStatement: FIND with threshold-prefixed result range", () => {
    const r = validateRoundTrip("```FIND (known://**) <0.7,10,20>\n~concessions\n```");
    assert.equal(r!.valid, true, JSON.stringify(r!.errors));
});

test("PlurnkStatement: TASK normalizes a tolerated plaintext body", () => {
    const parsed = PlurnkParser.parseStatements("```TASK\nDecompose the prompt; discover, record, deliver.\n```");
    const item = parsed.items.find((item) => item.kind === "statement");
    assert.ok(item?.kind === "statement" && item.statement.op === "TASK");
    assert.deepEqual(item.statement.body, [{ content: "Decompose the prompt; discover, record, deliver.", status: "in_progress" }]);
    assert.equal(Validator.validatePlurnkStatement(item.statement).valid, true);
});

test("PlurnkStatement: KILL with bare target", () => {
    const r = validateRoundTrip("```KILL (sh:///3/1/2)```");
    assert.equal(r!.valid, true, JSON.stringify(r!.errors));
});

test("PlurnkStatement: KILL with signal and annotation body", () => {
    const r = validateRoundTrip("```KILL (sh:///3/1/2)\nrunaway; no output for 4 turns\n```");
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
    annotation: null,
    target: null,
    metadata: null,
    lineMarker: null,
    body: null,
    position: { line: 1, column: 0 },
});

const transferFields = (op: "COPY" | "MOVE") => ({
    op,
    annotation: null,
    source: { target: parsePath("source")!, metadata: null, lineMarker: null },
    destination: { target: parsePath("destination")!, metadata: null, lineMarker: null },
    position: { line: 1, column: 0 },
});

test("PlurnkStatement: SEND rejects array signal", () => {
    const stmt = { ...baseFields("SEND"), signal: [] };
    const { valid } = Validator.validatePlurnkStatement(stmt);
    assert.equal(valid, false);
});

test("PlurnkStatement: SEND rejects string signal", () => {
    const stmt = { ...baseFields("SEND"), signal: "abc" };
    const { valid } = Validator.validatePlurnkStatement(stmt);
    assert.equal(valid, false);
});

test("PlurnkStatement: TASK accepts a wait scope", () => {
    const stmt = { ...baseFields("TASK"), body: [], lineMarker: { marks: [30] } };
    const { valid, errors } = Validator.validatePlurnkStatement(stmt);
    assert.equal(valid, true, JSON.stringify(errors));
});
test("PlurnkStatement: EXEC rejects numeric signal", () => {
    const stmt = { ...baseFields("EXEC"), status: 200 };
    const { valid } = Validator.validatePlurnkStatement(stmt);
    assert.equal(valid, false);
});

test("PlurnkStatement: EXEC accepts a lineMarker (timeout,poll)", () => {
    const stmt = { ...baseFields("EXEC"), executor: "node", target: { kind: "local", raw: "tool.py" }, lineMarker: { marks: [60, 5] } };
    const { valid } = Validator.validatePlurnkStatement(stmt);
    assert.equal(valid, true);
});

test("PlurnkStatement: TASK rejects numeric signal", () => {
    const stmt = { ...baseFields("TASK"), body: [], signal: 42 };
    const { valid } = Validator.validatePlurnkStatement(stmt);
    assert.equal(valid, false);
});

test("{§plan-slotless} PlurnkStatement: TASK permits timing but not targets or metadata", () => {
    const task = { ...baseFields("TASK"), body: [] };
    assert.equal(Validator.validatePlurnkStatement(task).valid, true);
    assert.equal(Validator.validatePlurnkStatement({ ...task, lineMarker: { marks: [1] } }).valid, true);
    for (const patch of [
        { target: parsePath("notes.md") },
        { metadata: ["x: y"] },
    ]) {
        const { valid } = Validator.validatePlurnkStatement({ ...task, ...patch });
        assert.equal(valid, false, JSON.stringify(patch));
    }
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
test("PlurnkStatement: FIND accepts lineMarker", () => {
    const stmt = { ...baseFields("FIND"), lineMarker: { marks: [1, 10] } };
    const { valid, errors } = Validator.validatePlurnkStatement(stmt);
    assert.equal(valid, true, JSON.stringify(errors));
});

test("PlurnkStatement: COPY requires exactly two resource selections and no body", () => {
    const statement = transferFields("COPY");
    assert.equal(Validator.validatePlurnkStatement(statement).valid, true);
    const { destination: _destination, ...missingDestination } = statement;
    assert.equal(Validator.validatePlurnkStatement(missingDestination).valid, false);
    assert.equal(Validator.validatePlurnkStatement({ ...statement, body: "destination" }).valid, false);
});

test("PlurnkStatement: COPY operands independently accept metadata and text scope", () => {
    const stmt = {
        ...transferFields("COPY"),
        source: {
            target: parsePath("known://draft/source")!,
            metadata: ["source metadata"],
            lineMarker: { marks: [1, 4] },
        },
        destination: {
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
            metadata: ["destination metadata"],
            lineMarker: { marks: [12, 5, 12, 5] },
        },
    };
    const { valid, errors } = Validator.validatePlurnkStatement(stmt);
    assert.equal(valid, true, JSON.stringify(errors));
});

test("PlurnkStatement: SEND body must be SendBody shape (raw + json)", () => {
    const stmt = { ...baseFields("SEND"), status: 200, body: "just a string" };
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
    const r = validateRoundTrip("```FIND (known://docs) <1>\n*.xml\n```");
    assert.equal(r!.valid, true, JSON.stringify(r!.errors));
});

test("PlurnkStatement: round-trip survives slot-order permutation (L-first)", () => {
    const r = validateRoundTrip("```FIND <1-5> (known://docs)\n*.xml\n```");
    assert.equal(r!.valid, true, JSON.stringify(r!.errors));
});
