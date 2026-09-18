// {§fence-boundary} {§matcher-prefix-claims}: closed malformed blocks are local failures.
import test from "node:test";
import assert from "node:assert/strict";
import { PlurnkParser } from "../../src/index.ts";
import AstBuilder from "../../src/AstBuilder.ts";
import { writtenOp } from "@plurnk/plurnk-contracts";

const statements = (r: ReturnType<typeof PlurnkParser.parseClient>) => r.items.flatMap((i) => i.kind === "statement" ? [i.statement] : []);
const errors = (r: ReturnType<typeof PlurnkParser.parseClient>) => r.items.flatMap((i) => i.kind === "error" ? [i.error] : []);
const frame = PlurnkParser.frame;
const task = (op = "WAIT") => frame(op, "Observe the results.");
const turn = (...blocks: string[]) => [...blocks, task()].join("\n");

// {§error-shape}: a failed statement cannot lend its normalization warnings to another.
for (const [name, header, body] of [
    ["scope", "READ (data.json) <@12> $[", null],
    ["aside", "READ (data.json) $[", "<!-- misplaced aside -->"],
    ["body", "READ (data.json) $[", "ignored content"],
] as const) {
    for (const separate of [false, true]) {
        test(`failed ${name} normalization does not leak advisories into ${separate ? "another parse" : "the next statement"}`, () => {
            const malformed = frame(header, body);
            const valid = frame("READ (data.json) $.ok", null);
            const results = separate
                ? [PlurnkParser.parseStatements(malformed), PlurnkParser.parseStatements(valid)]
                : [PlurnkParser.parseStatements([malformed, valid].join("\n"))];
            const diagnostics = results.flatMap(errors);
            assert.equal(diagnostics.length, 1);
            assert.equal(diagnostics[0].severity, "error");
            assert.equal(diagnostics[0].source, "visitor");
            assert.equal(diagnostics[0].line, 1);
            assert.match(diagnostics[0].message, /pattern leads with `\$` but is not a valid jsonpath/u);
            const ops = results.flatMap(statements);
            assert.equal(ops.length, 1);
            assert.equal(ops[0].op, "READ");
            assert.deepEqual("matcher" in ops[0] && ops[0].matcher, { dialect: "jsonpath", raw: "$.ok" });

            const normalized = PlurnkParser.parseStatements(frame("READ (data.json) <@34> $.ok", null));
            assert.deepEqual(normalized.items.map((item) => item.kind), ["statement", "error"]);
            assert.deepEqual(errors(normalized).map((error) => [error.severity, error.message]), [
                ["warning", "`@34` was read as line 34; an anchor is five characters (`@abcde`)."],
            ]);
        });
    }
}

test("an internal builder failure propagates without leaking its advisories", (t) => {
    const build = AstBuilder.build;
    const failure = new Error("internal builder failure");
    const mocked = t.mock.method(AstBuilder, "build", (...args: Parameters<typeof build>) => {
        build(...args);
        throw failure;
    });
    assert.throws(() => PlurnkParser.parseStatements(frame("READ (data.json) <@12> $.ok", null)), (error) => error === failure);
    mocked.mock.restore();
    const parsed = PlurnkParser.parseStatements(frame("READ (data.json) $.ok", null));
    assert.deepEqual(errors(parsed), []);
    assert.deepEqual(statements(parsed).map(writtenOp), ["READ"]);
});

test("a scope inside a target is applied with one factual warning per selection", () => {
    const r = PlurnkParser.parse(turn(frame("COPY (worker:///src.md<2,3>) (worker:///slice.md<1,-1>)", null), frame("READ (a.ts<4,5>)", null)));
    assert.equal(r.unparsedTail, undefined);
    const errs = errors(r);
    assert.deepEqual(errs.map((e) => [e.line, e.severity]), [[1, "warning"], [1, "warning"], [3, "warning"]]);
    assert.equal(errs[0].message, "The scope was inside the target slot; it was applied as the operation scope.");
    assert.equal(errs[0].column, 26);
    const ops = statements(r);
    assert.deepEqual(ops.map(writtenOp), ["COPY", "READ", "WAIT"]);
    const copy = ops[0];
    assert.ok(copy.op === "COPY");
    assert.equal(copy.source.target.raw, "worker:///src.md");
    assert.deepEqual(copy.source.lineMarker, { marks: [2, 3] });
    assert.equal(copy.destination.target.raw, "worker:///slice.md");
    assert.deepEqual(copy.destination.lineMarker, { marks: [1, -1] });
    const read = ops[1];
    assert.ok(read.op === "READ");
    assert.equal(read.target?.raw, "a.ts");
    assert.deepEqual(read.lineMarker, { marks: [4, 5] });
    assert.equal(r.items.findIndex((i) => i.kind === "error"), 1);

    const stray = PlurnkParser.parse(turn(frame("READ (a<b.ts) <1,-1>", null)));
    assert.ok(errors(stray).some((e) => e.severity === "error" && /unrecognized character '<'/.test(e.message)));
});

test("conflicting scopes on one resource selection are rejected without affecting the next block", () => {
    for (const header of ["READ (a.ts<1,2>) <3,4>", "COPY (a.ts<1>) <2> (b.ts)", "sh (script.js<5>) <10>"]) {
        const r = PlurnkParser.parse(turn(frame(header, null)));
        assert.equal(r.unparsedTail, undefined, header);
        assert.equal(errors(r).filter((e) => e.severity === "error").length, 1, header);
        assert.deepEqual(statements(r).map(writtenOp), ["WAIT"], header);
    }
});

test("a malformed block never downgrades a conclusion", () => {
    const r = PlurnkParser.parse([frame("READ (b.ts) <1,-1>", null), frame("READ [+diff] (a.ts) <1,-1>", null), task()].join("\n"));
    assert.equal(errors(r).length, 1);
    assert.deepEqual(statements(r).map(writtenOp), ["READ", "WAIT"]);
    const send = statements(r).find((s) => s.op === "WAIT");
    assert.equal(send?.op, "WAIT");
    assert.equal(send?.position.line, 5);
});

// {§legacy-bracket-slot}
test("bracket metadata belongs to a target, executor, or targetless SEND", () => {
    for (const [header, op, target, metadata] of [
        ["READ (a.ts) [+diff] <1,-1>", "READ", "a.ts", "+diff"],
        ["KILL (log://**) [memory]", "KILL", "log://**", "memory"],
        ['sh (greet.sh) [{"cwd": "sub"}]', "sh", "greet.sh", '{"cwd": "sub"}'],
        ['SEND [{"attachments":["report.pdf"]}]', "SEND", null, '{"attachments":["report.pdf"]}'],
        ["SEND [102]", "SEND", null, "102"],
    ] as const) {
        const r = PlurnkParser.parse(turn(frame(header, null)));
        assert.deepEqual(errors(r), [], header);
        assert.equal(r.unparsedTail, undefined, header);
        assert.deepEqual(statements(r).map(writtenOp), [op, "WAIT"], header);
        const [statement] = statements(r);
        if (!("metadata" in statement)) assert.fail(header);
        assert.equal(statement.target?.raw ?? null, target, header);
        assert.deepEqual(statement.metadata, [metadata], header);
    }
    for (const header of ["READ [+diff] (a.ts) <1,-1>", "KILL [memory] (log://**)"]) {
        const r = PlurnkParser.parse(turn(frame(header, "body")));
        assert.equal(errors(r).length, 1, header);
        assert.equal(errors(r)[0].line, 1, header);
        assert.equal(errors(r)[0].message, "unexpected bracket modifier; the fence name selects the executor", header);
        assert.equal(r.unparsedTail, undefined, header);
        assert.deepEqual(statements(r).map(writtenOp), ["WAIT"], header);
    }
    const r = PlurnkParser.parse(turn(frame("sh (greet.sh)", "body")));
    assert.deepEqual(errors(r), []);
    assert.deepEqual(statements(r).map(writtenOp), ["sh", "WAIT"]);
});

for (const header of [
    "FIND (/needle/) (src/) <1,-1>",
    "READ (a.md) <2,3> (extra.md)",
    "EDIT (a.md) (extra.md)",
    "KILL (a.md) (extra.md)",
    "SEND (worker://child) (extra.md)",
    "BARE (a.md) (extra.md)",
    "WORK (worker://child) (extra.md)",
    "FORK (worker://child) (extra.md)",
    "COPY (worker:///src.md) <2,3> (to) (worker:///slice.md)",
    "MOVE (😀.md) <2,3> (dest.md) <0> (extra.md)",
]) {
    test(`{§extra-path-slot}: ${header} reports its unexpected slot without assuming intent`, () => {
        for (const parse of [PlurnkParser.parse, PlurnkParser.parseStatements, PlurnkParser.parseClient]) {
            const r = parse(turn(frame(header, null)));
            const [error] = errors(r);
            assert.equal(errors(r).length, 1);
            assert.equal(error.severity, "error");
            assert.equal(error.source, "parser");
            assert.equal(error.line, 1);
            assert.equal(error.column, 4 + Array.from(header.slice(0, header.lastIndexOf("("))).length);
            assert.match(error.message, /^unexpected `\(` \(`\(path\)` slot opener\)/u);
            assert.doesNotMatch(error.message, /pattern|exactly one|OPEN_|LPAREN|RPAREN/u);
            assert.equal(r.unparsedTail, undefined);
            assert.deepEqual(statements(r).map(writtenOp), ["WAIT"]);
        }
    });
}

test("a plus-prefixed path is still a path, alone or as an extglob", () => {
    for (const [header, target] of [["READ (+page.svelte) <1,-1>", "+page.svelte"], ["READ (+diff) <1,-1>", "+diff"], ["FIND (src/+(a|b).ts) <1,-1>", "src/+(a|b).ts"]]) {
        const r = PlurnkParser.parse(turn(frame(header, null)));
        assert.deepEqual(errors(r), [], header);
        const op = statements(r)[0];
        assert.equal("target" in op ? op.target?.raw : null, target);
    }
});

test("duplicate dispositions are structural failures, never a false unclosed tail", () => {
    for (const op of ["WAIT"]) {
        const r = PlurnkParser.parse([task(op), task()].join("\n"));
        assert.equal(r.unparsedTail, undefined);
        assert.equal(errors(r).length, 1);
        assert.equal(errors(r)[0].message, "A turn permits only one WAIT.");
        assert.equal(errors(r)[0].code, "invalid-turn-structure");
        assert.equal(errors(r)[0].line, 4);
        assert.deepEqual(statements(r).map(writtenOp), [op]);
    }
});
