// {§fence-boundary} {§matcher-prefix-claims}: closed malformed blocks are local failures.
import test from "node:test";
import assert from "node:assert/strict";
import { PlurnkParser } from "../../src/index.ts";

const statements = (r: ReturnType<typeof PlurnkParser.parse>) => r.items.flatMap((i) => i.kind === "statement" ? [i.statement] : []);
const errors = (r: ReturnType<typeof PlurnkParser.parse>) => r.items.flatMap((i) => i.kind === "error" ? [i.error] : []);
const frame = PlurnkParser.frame;
const turn = (...blocks: string[]) => [...blocks, frame("NEXT", "next")].join("\n");

test("a scope inside a target is applied with one factual warning per selection", () => {
    const r = PlurnkParser.parse(turn(frame("COPY (worker:///src.md<2,3>) (worker:///slice.md<1,-1>)", null), frame("READ (a.ts<4,5>)", null)));
    assert.equal(r.unparsedTail, undefined);
    const errs = errors(r);
    assert.deepEqual(errs.map((e) => [e.line, e.severity]), [[1, "warning"], [1, "warning"], [2, "warning"]]);
    assert.equal(errs[0].message, "The scope was inside the target slot; it was applied as the operation scope.");
    assert.equal(errs[0].column, 25);
    const ops = statements(r);
    assert.deepEqual(ops.map(({ op }) => op), ["COPY", "READ", "NEXT"]);
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
        assert.deepEqual(statements(r).map(({ op }) => op), ["NEXT"], header);
    }
});

test("a malformed block never downgrades a conclusion", () => {
    const r = PlurnkParser.parse([frame("READ (b.ts) <1,-1>", null), frame("READ [+diff] (a.ts) <1,-1>", null), frame("DONE", "done")].join("\n"));
    assert.equal(errors(r).length, 1);
    assert.deepEqual(statements(r).map(({ op }) => op), ["READ", "DONE"]);
    const send = statements(r).find((s) => s.op === "DONE");
    assert.equal(send?.op, "DONE");
    assert.equal(send?.position.line, 3);
});

// {§legacy-bracket-slot}
test("bracket modifiers have one bounded diagnostic without guessing intent", () => {
    for (const header of ["READ [+diff] (a.ts) <1,-1>", "SEND [102]", "KILL [memory] (log://**)", "EXEC [sh]"]) {
        const r = PlurnkParser.parse(turn(frame(header, "body")));
        assert.equal(errors(r).length, 1, header);
        assert.equal(errors(r)[0].line, 1, header);
        assert.equal(errors(r)[0].message, "unexpected bracket modifier; the fence name selects the executor", header);
        assert.equal(r.unparsedTail, undefined, header);
        assert.deepEqual(statements(r).map(({ op }) => op), ["NEXT"], header);
    }
    const r = PlurnkParser.parse(turn(frame("sh (greet.sh)", "body")));
    assert.deepEqual(errors(r), []);
    assert.deepEqual(statements(r).map(({ op }) => op), ["EXEC", "NEXT"]);
});

test("a second path on a one-path operation names the slot contract", () => {
    const r = PlurnkParser.parse(turn(frame("FIND (/needle/) (src/) <1,-1>", null)));
    assert.equal(errors(r).length, 1);
    assert.equal(errors(r)[0].message, "a heading takes exactly one `(path)` slot; a pattern belongs in the body beneath the heading");
    assert.deepEqual(statements(r).map(({ op }) => op), ["NEXT"]);
});

test("a plus-prefixed path is still a path, alone or as an extglob", () => {
    for (const [header, target] of [["READ (+page.svelte) <1,-1>", "+page.svelte"], ["READ (+diff) <1,-1>", "+diff"], ["FIND (src/+(a|b).ts) <1,-1>", "src/+(a|b).ts"]]) {
        const r = PlurnkParser.parse(turn(frame(header, null)));
        assert.deepEqual(errors(r), [], header);
        const op = statements(r)[0];
        assert.equal("target" in op ? op.target?.raw : null, target);
    }
});

test("duplicate dispositions are structural failures, never a false unclosed tail", () => {
    for (const labels of [["DONE", "NEXT"], ["NEXT", "DONE"]]) {
        const r = PlurnkParser.parse([...labels.map((label) => frame(label, "done"))].join("\n"));
        assert.equal(r.unparsedTail, undefined);
        assert.equal(errors(r).length, 1);
        assert.equal(errors(r)[0].message, "A turn permits only one disposition: NEXT, WAIT, DONE, or FAIL.");
        assert.equal(errors(r)[0].code, "invalid-turn-structure");
        assert.equal(errors(r)[0].line, 4);
        assert.deepEqual(statements(r).map(({ op }) => op), [labels[0]]);
    }
});
