// {§matcher-prefix-claims} "later statements remain recoverable when their boundaries are
// trustworthy" — a column-0 heading is that boundary, and the turn shape is decided locally.
// #425 F2: one malformed heading produced three error rows and lost the terminal SEND.
import test from "node:test";
import assert from "node:assert/strict";
import { PlurnkParser } from "../../src/index.ts";

const statements = (r: ReturnType<typeof PlurnkParser.parse>) => r.items.flatMap((i) => i.kind === "statement" ? [i.statement] : []);
const errors = (r: ReturnType<typeof PlurnkParser.parse>) => r.items.flatMap((i) => i.kind === "error" ? [i.error] : []);
const targetOf = (s: { op: string }): string | undefined => "target" in s ? (s as { target: { raw?: string } | null }).target?.raw : undefined;
test("a scope written inside the path slot is tolerated with a warning: the statement runs with the scope after the path (#442)", () => {
    const r = PlurnkParser.parse("## PLAN0\nx\n### COPY0 (worker:///src.md<2,3>) (worker:///slice.md<1,-1>)\n### READ0 (a.ts<4,5>)\n### SEND0 (NEXT)\nnext\n");
    assert.equal(r.unparsedTail, undefined);
    const errs = errors(r);
    assert.deepEqual(errs.map((e) => [e.line, e.severity]), [[3, "warning"], [3, "warning"], [4, "warning"]], "one warning per slipped slot, never a strike");
    assert.equal(errs[0]!.message, "`<2,3>` belongs after the `(path)` slot, not inside it - `(path) <2,3>` was used.");
    assert.equal(errs[0]!.column, 28, "blamed at the `<` inside the first slot");
    const ops = statements(r);
    assert.deepEqual(ops.map((s) => s.op), ["PLAN", "COPY", "READ", "SEND"], "every statement stands");
    const copy = ops[1] as unknown as { source: { target: { raw: string }; lineMarker: unknown }; destination: { target: { raw: string }; lineMarker: unknown } };
    assert.equal(copy.source.target.raw, "worker:///src.md");
    assert.deepEqual(copy.source.lineMarker, { marks: [2, 3] }, "the source scope rides where it belongs");
    assert.equal(copy.destination.target.raw, "worker:///slice.md");
    assert.deepEqual(copy.destination.lineMarker, { marks: [1, -1] }, "the destination scope too");
    const read = ops[2] as unknown as { target: { raw: string }; lineMarker: unknown };
    assert.equal(read.target.raw, "a.ts");
    assert.deepEqual(read.lineMarker, { marks: [4, 5] });
    assert.equal(r.items.findIndex((i) => i.kind === "error"), 2, "the scolds sit right after their statement");
    // A stray `<` that is not a trailing scope is still the lexer's refusal, as before.
    const stray = PlurnkParser.parse("## PLAN0\nx\n### READ0 (a<b.ts) <1,-1>\n### SEND0 (NEXT)\nnext\n");
    assert.ok(errors(stray).some((e) => e.severity === "error" && /unrecognized character '<'/.test(e.message)));
});
test("a malformed heading never downgrades a conclusion", () => {
    const r = PlurnkParser.parse("## PLAN0\nx\n### READ0 (b.ts) <1,-1>\n### READ0 [+diff] (a.ts) <1,-1>\n### SEND0 (TERM)\ndone\n");
    assert.equal(errors(r).length, 1);
    assert.equal(statements(r).length, 3, "PLAN, the well-formed READ, SEND - the legacy heading is refused");
    const send = statements(r).find((s) => s.op === "SEND")!;
    assert.equal(send.status, 200);
    assert.equal(send.position.line, 5);
});

// {§legacy-bracket-slot}
test("a bracket on any heading but EXEC is one bounded diagnostic naming the executor rule", () => {
    for (const [heading, op] of [["### READ0 [+diff] (a.ts) <1,-1>", "READ"], ["### SEND0 [102]", "SEND"], ["### KILL0 [memory] (log://**)", "KILL"]] as const) {
        const r = PlurnkParser.parse(`## PLAN0\nx\n${heading}\nbody\n### SEND0 (NEXT)\nnext\n`);
        const errs = errors(r);
        assert.equal(errs.length, 1, heading);
        assert.equal(errs[0]!.line, 3, heading);
        assert.equal(errs[0]!.message, `unrecognized character '[' in a ${op} heading - \`[executor]\` belongs to EXEC only (\`### EXEC0 [python3] (tool.py)\`); ${op} takes \`(path)\``, heading);
        assert.equal(r.unparsedTail, undefined, heading);
        assert.deepEqual(statements(r).map((s) => s.op), ["PLAN", "SEND"], `${heading}: the bracketed statement is dropped, the turn concludes`);
    }
    const exec = PlurnkParser.parse("## PLAN0\nx\n### EXEC0 [sh] (greet.sh)\nbody\n### SEND0 (NEXT)\nnext\n");
    assert.equal(errors(exec).length, 0);
    assert.deepEqual(statements(exec).map((s) => s.op), ["PLAN", "EXEC", "SEND"]);
});

test("a second path slot that is not a tag names the one-slot rule at the second paren", () => {
    const r = PlurnkParser.parse("## PLAN0\nx\n### FIND0 (/needle/) (src/) <1,-1>\n### SEND0 (NEXT)\nnext\n");
    const errs = errors(r);
    assert.equal(errs.length, 1);
    assert.equal(errs[0]!.message, "a heading takes exactly one `(path)` slot; a pattern belongs in the body beneath the heading");
    assert.deepEqual(statements(r).map((s) => s.op), ["PLAN", "SEND"]);
});
test("a legitimate + path is still a path, alone or as an extglob", () => {
    for (const [heading, target] of [["### READ0 (+page.svelte) <1,-1>", "+page.svelte"], ["### READ0 (+diff) <1,-1>", "+diff"], ["### FIND0 (src/+(a|b).ts) <1,-1>", "src/+(a|b).ts"]] as const) {
        const r = PlurnkParser.parse(`## PLAN0\nx\n${heading}\n### SEND0 (NEXT)\nnext\n`);
        assert.equal(errors(r).length, 0, heading);
        assert.equal(targetOf(statements(r)[1]!), target);
    }
});

test("statements after the terminal SEND are the mid-termination error, never a false unclosed tail", () => {
    for (const text of [
        "## PLAN0\ninspect\n### SEND0 (TERM)\ndone\n### READ0 (late.md)\n",
        "## PLAN0\nx\n### SEND0 (NEXT)\na\n### SEND0 (TERM)\nb\n",
    ]) {
        const r = PlurnkParser.parse(text);
        assert.equal(r.unparsedTail, undefined, text);
        const errs = errors(r);
        assert.equal(errs.length, 1);
        assert.equal(errs[0]!.message, "`### SEND0 (NEXT|WAIT|TERM|FAIL)` ends the turn - nothing may follow it");
        assert.equal(errs[0]!.line, 5);
        assert.deepEqual(statements(r).map((s) => s.op), ["PLAN", "SEND"]);
    }
});
