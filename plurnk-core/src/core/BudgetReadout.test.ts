import test from "node:test";
import assert from "node:assert/strict";
import BudgetReadout from "./BudgetReadout.ts";
import { rulerCount } from "./token-ruler.ts";

const resolve = (ceiling: number, baseWeight: number): { content: string; usage: number } => {
    const prefix = "x".repeat(baseWeight * 2);
    const measure = (content: string): number => rulerCount(prefix + content);
    const content = BudgetReadout.resolve(BudgetReadout.draft(ceiling), ceiling, measure);
    return { content, usage: measure(content) };
};

test("BudgetReadout: displayed usage is the exact final render-weight", () => {
    const { content, usage } = resolve(100_000, 100);
    assert.match(content, new RegExp(`Token Usage ${usage} \\(<1%\\)`));
    assert.equal(content.split("\n").length, 1);
});

test("BudgetReadout: decimal-width boundaries converge without off-by-one substitution", async (t) => {
    const cases = [
        {
            name: "free contracts from two digits to one",
            ceiling: 100,
            baseWeight: 62,
            expected: "Token Ceiling 100 · Token Usage 91 (91%) · Tokens Free  9",
        },
        {
            name: "usage expands from two digits to three",
            ceiling: 200,
            baseWeight: 71,
            expected: "Token Ceiling 200 · Token Usage 101 (51%) · Tokens Free  99",
        },
        {
            name: "sub-one percent contracts to one percent",
            ceiling: 2_801,
            baseWeight: 0,
            expected: "Token Ceiling 2801 · Token Usage 30 ( 1%) · Tokens Free 2771",
        },
        {
            name: "overshoot expands usage and percentage by several widths",
            ceiling: 9,
            baseWeight: 62,
            expected: "Token Ceiling 9 · Token Usage 145 (1611%) · Tokens Free -136\nContext Token Budget Panic: YOU MUST FOLD or KILL enough less-relevant log items to restore free tokens.",
        },
    ] as const;

    for (const specimen of cases) {
        await t.test(specimen.name, () => {
            const { content, usage } = resolve(specimen.ceiling, specimen.baseWeight);
            assert.equal(content, specimen.expected);
            assert.equal(usage, Number(/Token Usage\s+(\d+)/u.exec(content)?.[1]));
        });
    }
});

test("BudgetReadout: negative pressure is explicit and carries one transient curation imperative", () => {
    const { content, usage } = resolve(9, 62);
    assert.equal(content.match(/Context Token Budget Panic:/gu)?.length, 1);
    assert.match(content, new RegExp(`Token Usage\\s+${usage} \\(\\d+%\\) · Tokens Free -\\d+`));
});

test("BudgetReadout: malformed templates and measurements fail at their owner", () => {
    assert.throws(
        () => BudgetReadout.resolve("Token Usage {{tokenUsage}}", 100, () => 10),
        /must contain \{\{tokenPercent\}\} exactly once/,
    );
    assert.throws(
        () => BudgetReadout.resolve(BudgetReadout.draft(100), 100, () => Number.NaN),
        /packet weight must be a non-negative safe integer/,
    );
});
