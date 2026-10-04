import test from "node:test";
import assert from "node:assert/strict";
import BudgetReadout from "./BudgetReadout.ts";
import { contentWeight } from "./content-weight.ts";

interface Gauge { tokens: number; budget?: number; largest: Array<{ path: string; tokens: number }> }

const resolve = (
    budget: number | null,
    baseWeight: number,
    largest: ReadonlyArray<{ path: string; tokens: number }> = [],
): { content: string; usage: number; gauge: Gauge } => {
    const prefix = "x".repeat(baseWeight * 2);
    const measure = (content: string): number => contentWeight(prefix + content);
    const content = BudgetReadout.resolve(BudgetReadout.draft(budget), budget, measure, largest);
    return { content, usage: measure(content), gauge: JSON.parse(content) as Gauge };
};

test("{§context-gauge} the gauge is one JSON object: tokens as the exact render-weight, the budget, and the largest rows", () => {
    const { content, usage, gauge } = resolve(100_000, 100);
    assert.equal(content.split("\n").length, 1, "one JSON line and nothing beneath it");
    assert.deepEqual(gauge, { tokens: usage, budget: 100_000, largest: [] });
    assert.deepEqual(Object.keys(gauge), ["tokens", "budget", "largest"]);
});

test("{§context-gauge} the gauge reads the same at one percent as at ninety-nine: no threshold, no warning, no mandate", () => {
    const items = [{ path: "log:///1/1/1/READ", tokens: 110 }];
    for (const base of [0, 700, 950]) {
        const { content, usage, gauge } = resolve(1_000, base, items);
        assert.doesNotMatch(content, /WARNING|MUST/u, `at ${base} of 1000 the gauge carries no mandate`);
        assert.equal(gauge.tokens, usage);
        assert.deepEqual(gauge.largest, items);
    }
    const over = resolve(9, 62);
    assert.ok(over.gauge.tokens > 9, "an over-budget packet reports its tokens honestly");
    assert.doesNotMatch(over.content, /WARNING|MUST/u);
});

test("BudgetReadout: decimal-width boundaries converge without off-by-one substitution", async (t) => {
    const cases = [
        { name: "two-digit total", budget: 100, baseWeight: 62 },
        { name: "total expands from two digits to three", budget: 200, baseWeight: 77 },
        { name: "small total under a wide budget", budget: 2_801, baseWeight: 0 },
        { name: "total overshoots a tiny budget", budget: 9, baseWeight: 62 },
        { name: "converted capacity cannot fit one curation unit", budget: 0, baseWeight: 62 },
    ] as const;
    for (const specimen of cases) {
        await t.test(specimen.name, () => {
            const { usage, gauge } = resolve(specimen.budget, specimen.baseWeight);
            assert.equal(gauge.tokens, usage, "the displayed total is the exact render-weight");
            assert.equal(gauge.budget, specimen.budget);
        });
    }
});

test("{§context-gauge} largest: ranked by tokens then path, bounded by PLURNK_SERVICE_BUDGET_LARGEST_ITEMS, always present", () => {
    const items = [
        { path: "log:///1/1/6/READ", tokens: 70 },
        { path: "log:///1/1/2/READ", tokens: 110 },
        { path: "log:///1/1/5/READ", tokens: 80 },
        { path: "log:///1/1/4/READ", tokens: 90 },
        { path: "log:///1/1/3/READ", tokens: 100 },
        { path: "log:///1/1/1/READ", tokens: 110 },
    ];
    const { content, usage, gauge } = resolve(1_500, 700, items);
    assert.match(content, /^\{"tokens":\s*\d+,"budget":1500,"largest":\[/u, "one JSON payload with the inventory folded in");
    assert.deepEqual(gauge.largest, [
        { path: "log:///1/1/1/READ", tokens: 110 },
        { path: "log:///1/1/2/READ", tokens: 110 },
        { path: "log:///1/1/3/READ", tokens: 100 },
        { path: "log:///1/1/4/READ", tokens: 90 },
        { path: "log:///1/1/5/READ", tokens: 80 },
    ], "rank by tokens, break ties by path, and bound the inventory at the shipped five");
    assert.equal(gauge.tokens, usage, "the displayed total includes the inventory");
    const prior = process.env.PLURNK_SERVICE_BUDGET_LARGEST_ITEMS;
    try {
        process.env.PLURNK_SERVICE_BUDGET_LARGEST_ITEMS = "2";
        assert.equal(resolve(1_500, 700, items).gauge.largest.length, 2, "the operator names how many rows the gauge names");
        process.env.PLURNK_SERVICE_BUDGET_LARGEST_ITEMS = "0";
        assert.deepEqual(resolve(1_500, 700, items).gauge.largest, [], "zero names none, and the field stays");
    } finally {
        if (prior === undefined) delete process.env.PLURNK_SERVICE_BUDGET_LARGEST_ITEMS; else process.env.PLURNK_SERVICE_BUDGET_LARGEST_ITEMS = prior;
    }
});

test("{§context-gauge} the inventory is the largest prefix that fits the budget", () => {
    const wide = { path: `log:///${"1".repeat(200)}/READ`, tokens: 110 };
    const narrow = { path: "log:///1/1/2/READ", tokens: 90 };
    const { usage, gauge } = resolve(1_000, 900, [wide, narrow]);
    assert.deepEqual(gauge.largest, [], "a prefix that cannot fit is cut down, to nothing when it must");
    assert.ok(usage <= 1_000, "the gauge never pushes a fitting packet over its budget");
    const fits = resolve(1_000, 900, [narrow, { ...narrow, path: "log:///1/1/3/READ", tokens: 80 }]);
    assert.equal(fits.gauge.largest.length, 2, "what fits is named");
    assert.ok(fits.usage <= 1_000);
});

test("{§tokenomics-window-unpollable-deliberate} without a budget the gauge carries tokens alone, and names every inventory row", () => {
    const items = [{ path: "log:///1/1/1/READ", tokens: 110 }, { path: "log:///1/1/2/READ", tokens: 100 }];
    const { usage, gauge } = resolve(null, 100, items);
    assert.deepEqual(Object.keys(gauge), ["tokens", "largest"]);
    assert.equal(gauge.tokens, usage);
    assert.deepEqual(gauge.largest, items);
});

test("BudgetReadout: malformed templates and measurements fail at their owner", () => {
    assert.throws(
        () => BudgetReadout.resolve('{"budget":100}', 100, () => 10),
        /must contain \{\{tokens\}\} exactly once/,
    );
    assert.throws(
        () => BudgetReadout.resolve(BudgetReadout.draft(100), 100, () => Number.NaN),
        /packet weight must be a non-negative safe integer/,
    );
    assert.throws(() => BudgetReadout.resolve(BudgetReadout.draft(100), 100, () => 10, [{ path: "file:///a", tokens: 1 }]), /one log:\/\/\/ URI/);
});

test("{§output-allowance-notice} (#826) the readout carries curation state and no output allowance", () => {
    const drafted = BudgetReadout.draft(1000);
    assert.match(drafted, /"budget":1000\}$/);
    assert.doesNotMatch(BudgetReadout.resolve(drafted, 1000, (candidate) => candidate.length), /tokensResponseMax|allowance|grant/u);
    assert.equal(BudgetReadout.draft(null), '{"tokens":{{tokens}}}');
});

test("{§tokenomics-calibrated-readout} a converted budget changes the room without changing cost units", () => {
    const prefix = "x".repeat(85 * 2);
    const measure = (content: string): number => contentWeight(prefix + content);
    const items = [{ path: "log:///1/2/3/READ", tokens: 44 }];
    for (const budget of [100, 200]) {
        const rendered = BudgetReadout.resolve(BudgetReadout.draft(budget), budget, measure, items);
        const usage = measure(rendered);
        assert.match(rendered, new RegExp(`"tokens":\\s*${usage},"budget":${budget}`, "u"), `the displayed figure retains the measured curation units; got: ${rendered}`);
        assert.doesNotMatch(rendered, /MUST/u);
    }
});
