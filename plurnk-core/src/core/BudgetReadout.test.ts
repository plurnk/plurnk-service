import test from "node:test";
import assert from "node:assert/strict";
import BudgetReadout from "./BudgetReadout.ts";
import { contentWeight } from "./content-weight.ts";

const resolve = (ceiling: number, baseWeight: number): { content: string; usage: number } => {
    const prefix = "x".repeat(baseWeight * 2);
    const measure = (content: string): number => contentWeight(prefix + content);
    const content = BudgetReadout.resolve(BudgetReadout.draft(ceiling), ceiling, measure);
    return { content, usage: measure(content) };
};

test("BudgetReadout: displayed usage is the exact final render-weight", () => {
    const { content, usage } = resolve(100_000, 100);
    assert.match(content, new RegExp(`tokensActiveTotal: ${usage} \\(<1%\\)`));
    assert.match(content, /tokensActiveMax: 100000/u);
    assert.equal(content.split("\n").length, 2);
});

test("BudgetReadout: decimal-width boundaries converge without off-by-one substitution", async (t) => {
    const cases = [
        {
            name: "two-digit total",
            ceiling: 100,
            baseWeight: 62,
            expected: "tokensActiveTotal: 86 (86%)\ntokensActiveMax: 100",
        },
        {
            name: "total expands from two digits to three",
            ceiling: 200,
            baseWeight: 77,
            expected: "tokensActiveTotal: 102 (51%)\ntokensActiveMax: 200",
        },
        {
            name: "sub-one percent contracts to one percent",
            ceiling: 2_801,
            baseWeight: 0,
            expected: "tokensActiveTotal: 25 (<1%)\ntokensActiveMax: 2801",
        },
        {
            name: "overshoot expands total and percentage by several widths",
            ceiling: 9,
            baseWeight: 62,
            expected: "tokensActiveTotal: 86 (956%)\ntokensActiveMax: 9",
        },
    ] as const;

    for (const specimen of cases) {
        await t.test(specimen.name, () => {
            const { content, usage } = resolve(specimen.ceiling, specimen.baseWeight);
            assert.equal(content, specimen.expected);
            assert.equal(usage, Number(/tokensActiveTotal:\s+(\d+)/u.exec(content)?.[1]));
        });
    }
});

test("BudgetReadout: over-ceiling pressure remains an honest two-field state", () => {
    const { content, usage } = resolve(9, 62);
    assert.match(content, new RegExp(`tokensActiveTotal:\\s+${usage} \\(\\d+%\\)`));
    assert.match(content, /tokensActiveMax: 9/u);
    assert.equal(content.split("\n").length, 2);
});

test("BudgetReadout: malformed templates and measurements fail at their owner", () => {
    assert.throws(
        () => BudgetReadout.resolve("tokensActiveTotal: {{tokensActiveTotal}}", 100, () => 10),
        /must contain \{\{tokenPercent\}\} exactly once/,
    );
    assert.throws(
        () => BudgetReadout.resolve(BudgetReadout.draft(100), 100, () => Number.NaN),
        /packet weight must be a non-negative safe integer/,
    );
});
