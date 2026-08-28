import test from "node:test";
import assert from "node:assert/strict";
import BudgetReadout from "./BudgetReadout.ts";
import { contentWeight } from "./content-weight.ts";

const resolve = (
    ceiling: number,
    baseWeight: number,
    largestLogItems: ReadonlyArray<{ path: string; tokensBody: number; tokensActive: number }> = [],
): { content: string; usage: number } => {
    const prefix = "x".repeat(baseWeight * 2);
    const measure = (content: string): number => contentWeight(prefix + content);
    const content = BudgetReadout.resolve(BudgetReadout.draft(ceiling), ceiling, measure, largestLogItems);
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

test("{§tokenomics-pressure-inventory}: the largest reclaimable log bodies appear only at pressure", () => {
    const items = [
        { path: "log:///1/1/6/READ", tokensBody: 60, tokensActive: 70 },
        { path: "log:///1/1/2/READ", tokensBody: 100, tokensActive: 110 },
        { path: "log:///1/1/5/READ", tokensBody: 70, tokensActive: 80 },
        { path: "log:///1/1/4/READ", tokensBody: 80, tokensActive: 90 },
        { path: "log:///1/1/3/READ", tokensBody: 90, tokensActive: 100 },
        { path: "log:///1/1/1/READ", tokensBody: 100, tokensActive: 110 },
    ];

    const below = resolve(1_000, 700, items);
    assert.doesNotMatch(below.content, /Largest Log Items/u, "neutral telemetry stays two lines below 80%");

    const pressured = resolve(1_000, 800, items);
    assert.match(pressured.content, /^tokensActiveTotal:\s+\d+ \(\s*\d+%\)\ntokensActiveMax: 1000\n\n### Largest Log Items:\n\n/u);
    assert.deepEqual(
        pressured.content.split("\n").filter((line) => line.startsWith("* ")),
        [
            '* log:///1/1/1/READ - {"tokensBody":100,"tokensActive":110}',
            '* log:///1/1/2/READ - {"tokensBody":100,"tokensActive":110}',
            '* log:///1/1/3/READ - {"tokensBody":90,"tokensActive":100}',
            '* log:///1/1/4/READ - {"tokensBody":80,"tokensActive":90}',
            '* log:///1/1/5/READ - {"tokensBody":70,"tokensActive":80}',
        ],
        "rank by active cost, break ties by path, and bound the recovery index at five",
    );
    assert.equal(
        Number(/tokensActiveTotal:\s+(\d+)/u.exec(pressured.content)?.[1]),
        pressured.usage,
        "the displayed total includes the conditional inventory",
    );
});

test("{§tokenomics-pressure-inventory}: recovery advice never creates an overflow", () => {
    const item = {
        path: `log:///${"1".repeat(200)}/READ`,
        tokensBody: 100,
        tokensActive: 110,
    };
    const pressured = resolve(1_000, 950, [item]);
    assert.doesNotMatch(pressured.content, /Largest Log Items/u, "an inventory that cannot fit is omitted");
    assert.ok(pressured.usage <= 1_000, "the neutral packet remains admissible");
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
