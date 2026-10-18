import test from "node:test";
import assert from "node:assert/strict";
import BudgetReadout from "./BudgetReadout.ts";
import { contentWeight } from "./content-weight.ts";

interface Gauge { tokens: number; budget?: number; percent?: number; largest?: Array<{ path: string; tokens: number }> }

const resolve = (
    budget: number | null,
    baseWeight: number,
    largest: ReadonlyArray<{ path: string; tokens: number }> = [],
): { content: string; usage: number; gauge: Gauge } => {
    const prefix = "x".repeat(baseWeight * 2);
    const measure = (content: string): number => contentWeight(prefix + content);
    const { gauge: content } = BudgetReadout.resolve(BudgetReadout.draft(budget), measure, largest);
    return { content, usage: measure(content), gauge: JSON.parse(content) as Gauge };
};

const share = (gauge: Gauge): number => Math.floor(gauge.tokens * 100 / gauge.budget!);

test("{§context-gauge} below pressure the gauge names its exact render-weight, its budget and its share", () => {
    const { content, usage, gauge } = resolve(100_000, 100);
    assert.equal(content.split("\n").length, 1, "one JSON line and nothing beneath it");
    assert.deepEqual(gauge, { tokens: usage, budget: 100_000, percent: share(gauge) });
    assert.deepEqual(Object.keys(gauge), ["tokens", "budget", "percent"], "the share sits after the totals");
});

test("{§context-gauge} the percent is the gauge's own final tokens over its budget, on every packet with a budget", () => {
    const items = [{ path: "log:///1/1/1/READ", tokens: 110 }];
    for (const base of [0, 700, 801, 950, 1_100]) {
        const { usage, gauge } = resolve(1_000, base, items);
        assert.equal(gauge.tokens, usage);
        assert.equal(gauge.percent, share(gauge), `at ${base} of 1000 the share is the final figures' own`);
        assert.equal(Object.keys(gauge)[2], "percent", "after tokens and budget, before any inventory");
    }
    const over = resolve(1_000, 1_100, items);
    assert.ok(over.gauge.percent! > 100, "over budget the share says so, and nothing else does");
});

test("{§context-gauge} inventory appears strictly above pressure, after the share, never with a warning or mandate", () => {
    const items = [{ path: "log:///1/1/1/READ", tokens: 110 }];
    for (const base of [0, 700, 950]) {
        const { content, usage, gauge } = resolve(1_000, base, items);
        assert.doesNotMatch(content, /WARNING|MUST/u, `at ${base} of 1000 the gauge carries no mandate`);
        assert.equal(gauge.tokens, usage);
        assert.deepEqual(gauge.largest, base > 800 ? items : undefined);
        assert.deepEqual(Object.keys(gauge), base > 800 ? ["tokens", "budget", "percent", "largest"] : ["tokens", "budget", "percent"]);
    }
    const over = resolve(9, 62);
    assert.ok(over.gauge.tokens > 9, "an over-budget packet reports its tokens honestly");
    assert.doesNotMatch(over.content, /WARNING|MUST/u);
});

test("{§context-gauge} the share converges when its own width moves the packet across a digit boundary", () => {
    // A base that lands the gauge within a token of 10% of its budget: the share's own digit count
    // (one or two) is part of the weight it describes, and the final figures agree with each other.
    for (const [budget, base] of [[1_000, 50], [1_000, 48], [100, 40], [250, 110]] as const) {
        const { usage, gauge } = resolve(budget, base);
        assert.equal(gauge.tokens, usage, `at ${base} under ${budget} the displayed total is the exact render-weight`);
        assert.equal(gauge.percent, share(gauge), `at ${base} under ${budget} the share is the final figures' own`);
    }
});

test("{§context-gauge} threshold eligibility excludes the inventory's own weight", () => {
    const items = [{ path: `log:///${"1".repeat(400)}/READ`, tokens: 110 }];
    for (const [weight, expected] of [[799, undefined], [800, undefined], [801, items]] as const) {
        const measure = (content: string): number => weight + (content.includes('"largest"') ? 250 : 0);
        const content = BudgetReadout.resolve(BudgetReadout.draft(1_000), measure, items).gauge;
        const gauge = JSON.parse(content) as Gauge;
        assert.deepEqual(gauge.largest, expected, `a base packet of ${weight} determines eligibility`);
        assert.equal(gauge.tokens, measure(content), "final tokens include the inventory when present");
        assert.equal(gauge.percent, share(gauge), "and so does the share");
    }
});

test("{§context-gauge} the configured pressure threshold controls inventory eligibility", () => {
    const items = [{ path: "log:///1/1/1/READ", tokens: 110 }];
    const prior = process.env.PLURNK_SERVICE_BUDGET_PRESSURE;
    try {
        process.env.PLURNK_SERVICE_BUDGET_PRESSURE = "60%";
        assert.deepEqual(resolve(1_000, 500, items).gauge.largest, undefined);
        assert.deepEqual(resolve(1_000, 700, items).gauge.largest, items);
    } finally {
        if (prior === undefined) delete process.env.PLURNK_SERVICE_BUDGET_PRESSURE; else process.env.PLURNK_SERVICE_BUDGET_PRESSURE = prior;
    }
});

test("{§context-gauge} BudgetReadout: decimal-width boundaries converge without off-by-one substitution", async (t) => {
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
            if (specimen.budget > 0) assert.equal(gauge.percent, share(gauge), "the share follows the total it sits beside");
        });
    }
});

test("{§context-gauge} largest: ranked by tokens then path and bounded by PLURNK_SERVICE_BUDGET_LARGEST_ITEMS", () => {
    const items = [
        { path: "log:///1/1/6/READ", tokens: 70 },
        { path: "log:///1/1/2/READ", tokens: 110 },
        { path: "log:///1/1/5/READ", tokens: 80 },
        { path: "log:///1/1/4/READ", tokens: 90 },
        { path: "log:///1/1/3/READ", tokens: 100 },
        { path: "log:///1/1/1/READ", tokens: 110 },
    ];
    const { content, usage, gauge } = resolve(1_500, 1_250, items);
    assert.match(content, /^\{"tokens":\s*\d+,"budget":1500,"percent":\s*\d+,"largest":\[/u, "one JSON payload with the inventory folded in after the share");
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
        assert.equal(resolve(1_500, 1_250, items).gauge.largest?.length, 2, "the operator names how many rows the gauge names");
        process.env.PLURNK_SERVICE_BUDGET_LARGEST_ITEMS = "0";
        assert.deepEqual(resolve(1_500, 1_250, items).gauge.largest, [], "zero names none above the threshold");
    } finally {
        if (prior === undefined) delete process.env.PLURNK_SERVICE_BUDGET_LARGEST_ITEMS; else process.env.PLURNK_SERVICE_BUDGET_LARGEST_ITEMS = prior;
    }
});

test("{§context-gauge} the complete configured inventory remains visible over budget", () => {
    const wide = { path: `log:///${"1".repeat(200)}/READ`, tokens: 110 };
    const narrow = { path: "log:///1/1/2/READ", tokens: 90 };
    const { usage, gauge } = resolve(1_000, 900, [narrow, wide]);
    assert.deepEqual(gauge.largest, [wide, narrow], "every ranked row is named, whatever it costs the gauge");
    assert.ok(usage > 1_000, "an over-budget packet reports its tokens honestly ({§context-over-budget-row})");
    const zero = resolve(0, 0, [narrow]);
    assert.ok(zero.usage > 0, "the packet exceeds a known zero budget");
    assert.deepEqual(zero.gauge.largest, [narrow], "zero capacity is pressure, not an unknown budget");
    assert.equal(zero.gauge.percent, undefined, "a zero room has no share to state");
});

test("{§tokenomics-window-unpollable-deliberate} without a budget the gauge carries tokens alone", () => {
    const items = [{ path: "log:///1/1/1/READ", tokens: 110 }, { path: "log:///1/1/2/READ", tokens: 100 }];
    const { usage, gauge } = resolve(null, 100, items);
    assert.deepEqual(Object.keys(gauge), ["tokens"]);
    assert.equal(gauge.tokens, usage);
    assert.equal(gauge.largest, undefined);
    assert.equal(gauge.percent, undefined, "no room, no share");
});

test("{§output-allowance-notice} (#826) the readout carries curation state alone", () => {
    const drafted = BudgetReadout.draft(1000);
    assert.match(drafted, /"budget":1000,"percent":\{\{percent\}\}\}$/);
    assert.deepEqual(Object.keys(JSON.parse(BudgetReadout.resolve(drafted, (candidate) => candidate.length).gauge)), ["tokens", "budget", "percent"],
        "the readout's facts are exactly its curation state");
    assert.equal(BudgetReadout.draft(null), '{"tokens":{{tokens}}}');
    assert.equal(BudgetReadout.draft(0), '{"tokens":{{tokens}},"budget":0}');
});

test("{§tokenomics-calibrated-readout} a converted budget changes the room without changing cost units", () => {
    const prefix = "x".repeat(85 * 2);
    const measure = (content: string): number => contentWeight(prefix + content);
    const items = [{ path: "log:///1/2/3/READ", tokens: 44 }];
    for (const budget of [100, 200]) {
        const rendered = BudgetReadout.resolve(BudgetReadout.draft(budget), measure, items).gauge;
        const usage = measure(rendered);
        assert.match(rendered, new RegExp(`"tokens":\\s*${usage},"budget":${budget},"percent":\\s*${Math.floor(usage * 100 / budget)}`, "u"), `the displayed figures retain the measured curation units; got: ${rendered}`);
        assert.doesNotMatch(rendered, /MUST/u);
    }
});
