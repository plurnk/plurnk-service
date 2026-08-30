// {§matcher-prefix-claims} "later statements remain recoverable when their boundaries are
// trustworthy" — a column-0 heading is that boundary, and the turn shape is decided locally.
// #425 F2: one malformed heading produced three error rows and lost the terminal SEND.
import test from "node:test";
import assert from "node:assert/strict";
import { PlurnkParser } from "../../src/index.ts";

const statements = (r: ReturnType<typeof PlurnkParser.parse>) => r.items.flatMap((i) => i.kind === "statement" ? [i.statement] : []);
const errors = (r: ReturnType<typeof PlurnkParser.parse>) => r.items.flatMap((i) => i.kind === "error" ? [i.error] : []);
const targetOf = (s: { op: string }): string | undefined => "target" in s ? (s as { target: { raw?: string } | null }).target?.raw : undefined;

test("a malformed heading costs one error and nothing else: later statements and the real terminal SEND survive", () => {
    const r = PlurnkParser.parse("# PLAN0\nx\n## READ0 (+diff) (a.ts) <1,-1>\n## READ0 (b.ts) <1,-1>\n## FIND0 (src/**) <1,-1>\n## SEND0 [102]\nnext\n");
    assert.equal(r.unparsedTail, undefined);
    const errs = errors(r);
    assert.equal(errs.length, 1, "exactly one diagnostic for one slip");
    assert.equal(errs[0]!.line, 3);
    assert.equal(errs[0]!.column, 9, "blamed at the FIRST paren, where the tag was written as a path");
    assert.equal(errs[0]!.message, "`(+diff)` is not a path - a tag rides in the signal slot `[+diff]`; `(...)` is the one path slot");
    const ops = statements(r).map((s) => `${s.op}${s.op === "SEND" ? `[${s.signal}]` : ""}${targetOf(s) ? `(${targetOf(s)})` : ""}`);
    assert.deepEqual(ops, ["PLAN", "READ(b.ts)", "FIND(src/**)", "SEND[102]"]);
    const send = statements(r).find((s) => s.op === "SEND")!;
    assert.equal(send.position.line, 6, "the model's own SEND, not an envelope substitution");
});

test("a malformed heading never downgrades a conclusion", () => {
    const r = PlurnkParser.parse("# PLAN0\nx\n## READ0 (b.ts) <1,-1>\n## READ0 (+diff) (a.ts) <1,-1>\n## SEND0 [200]\ndone\n");
    assert.equal(errors(r).length, 1);
    const send = statements(r).find((s) => s.op === "SEND")!;
    assert.equal(send.signal, 200);
    assert.equal(send.position.line, 5);
});

test("a second path slot that is not a tag names the one-slot rule at the second paren", () => {
    const r = PlurnkParser.parse("# PLAN0\nx\n## FIND0 [+t] (/needle/) (src/) <1,-1>\n## SEND0 [102]\nnext\n");
    const errs = errors(r);
    assert.equal(errs.length, 1);
    assert.equal(errs[0]!.message, "a heading takes exactly one `(path)` slot; a pattern belongs in the body beneath the heading");
    assert.deepEqual(statements(r).map((s) => s.op), ["PLAN", "SEND"]);
});

test("a legitimate + path is still a path, alone or as an extglob", () => {
    for (const [heading, target] of [["## READ0 (+page.svelte) <1,-1>", "+page.svelte"], ["## READ0 (+diff) <1,-1>", "+diff"], ["## FIND0 (src/+(a|b).ts) <1,-1>", "src/+(a|b).ts"]] as const) {
        const r = PlurnkParser.parse(`# PLAN0\nx\n${heading}\n## SEND0 [102]\nnext\n`);
        assert.equal(errors(r).length, 0, heading);
        assert.equal(targetOf(statements(r)[1]!), target);
    }
});

test("statements after the terminal SEND are the mid-termination error, never a false unclosed tail", () => {
    for (const text of [
        "# PLAN0\ninspect\n## SEND0 [200]\ndone\n## READ0 (late.md)\n",
        "# PLAN0\nx\n## SEND0 [102]\na\n## SEND0 [200]\nb\n",
    ]) {
        const r = PlurnkParser.parse(text);
        assert.equal(r.unparsedTail, undefined, text);
        const errs = errors(r);
        assert.equal(errs.length, 1);
        assert.equal(errs[0]!.message, "`## SEND0 [submit code]` ends the turn - nothing may follow it");
        assert.equal(errs[0]!.line, 5);
        assert.deepEqual(statements(r).map((s) => s.op), ["PLAN", "SEND"]);
    }
});
