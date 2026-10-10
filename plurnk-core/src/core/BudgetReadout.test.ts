import test from "node:test";
import assert from "node:assert/strict";
import type { Notice } from "@plurnk/plurnk-contracts";
import BudgetReadout from "./BudgetReadout.ts";
import { contentWeight } from "./content-weight.ts";
import PacketWire from "./packet-wire.ts";

interface Gauge { tokens: number; budget?: number; largest?: Array<{ path: string; tokens: number }> }

const resolve = (
    budget: number | null,
    baseWeight: number,
    largest: ReadonlyArray<{ path: string; tokens: number }> = [],
): { content: string; usage: number; gauge: Gauge; notice: Notice | null } => {
    const prefix = "x".repeat(baseWeight * 2);
    const measure = (content: string, notice: Notice | null): number =>
        contentWeight(prefix + content + (notice === null ? "" : PacketWire.renderNotices([notice])));
    const { gauge: content, notice } = BudgetReadout.resolve(BudgetReadout.draft(budget), measure, largest);
    return { content, usage: measure(content, notice), gauge: JSON.parse(content) as Gauge, notice };
};

test("{§context-gauge} below pressure the gauge names only its exact render-weight and budget", () => {
    const { content, usage, gauge } = resolve(100_000, 100);
    assert.equal(content.split("\n").length, 1, "one JSON line and nothing beneath it");
    assert.deepEqual(gauge, { tokens: usage, budget: 100_000 });
    assert.deepEqual(Object.keys(gauge), ["tokens", "budget"]);
});

test("{§context-gauge} inventory appears strictly above pressure, never with a warning or mandate", () => {
    const items = [{ path: "log:///1/1/1/READ", tokens: 110 }];
    for (const base of [0, 700, 950]) {
        const { content, usage, gauge } = resolve(1_000, base, items);
        assert.doesNotMatch(content, /WARNING|MUST/u, `at ${base} of 1000 the gauge carries no mandate`);
        assert.equal(gauge.tokens, usage);
        assert.deepEqual(gauge.largest, base > 800 ? items : undefined);
    }
    const over = resolve(9, 62);
    assert.ok(over.gauge.tokens > 9, "an over-budget packet reports its tokens honestly");
    assert.doesNotMatch(over.content, /WARNING|MUST/u);
});

test("{§context-gauge} threshold eligibility excludes the inventory's own weight", () => {
    const items = [{ path: `log:///${"1".repeat(400)}/READ`, tokens: 110 }];
    for (const [weight, expected] of [[799, undefined], [800, undefined], [801, items]] as const) {
        const measure = (content: string): number => weight + (content.includes('"largest"') ? 250 : 0);
        const content = BudgetReadout.resolve(BudgetReadout.draft(1_000), measure, items).gauge;
        const gauge = JSON.parse(content) as Gauge;
        assert.deepEqual(gauge.largest, expected, `a base packet of ${weight} determines eligibility`);
        assert.equal(gauge.tokens, measure(content), "final tokens include the inventory when present");
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
});

test("{§tokenomics-window-unpollable-deliberate} without a budget the gauge carries tokens alone", () => {
    const items = [{ path: "log:///1/1/1/READ", tokens: 110 }, { path: "log:///1/1/2/READ", tokens: 100 }];
    const { usage, gauge } = resolve(null, 100, items);
    assert.deepEqual(Object.keys(gauge), ["tokens"]);
    assert.equal(gauge.tokens, usage);
    assert.equal(gauge.largest, undefined);
});

test("BudgetReadout: malformed templates and measurements fail at their owner", () => {
    assert.throws(
        () => BudgetReadout.resolve('{"budget":100}', () => 10),
        /must contain \{\{tokens\}\} exactly once/,
    );
    assert.throws(
        () => BudgetReadout.resolve(BudgetReadout.draft(100), () => Number.NaN),
        /packet weight must be a non-negative safe integer/,
    );
    assert.throws(() => BudgetReadout.resolve(BudgetReadout.draft(100), () => 10, [{ path: "file:///a", tokens: 1 }]), /one log:\/\/\/ URI/);
});

test("{§output-allowance-notice} (#826) the readout carries curation state alone", () => {
    const drafted = BudgetReadout.draft(1000);
    assert.match(drafted, /"budget":1000\}$/);
    assert.deepEqual(Object.keys(JSON.parse(BudgetReadout.resolve(drafted, (candidate) => candidate.length).gauge)), ["tokens", "budget"],
        "the readout's facts are exactly its curation state");
    assert.equal(BudgetReadout.draft(null), '{"tokens":{{tokens}}}');
});

test("{§tokenomics-calibrated-readout} a converted budget changes the room without changing cost units", () => {
    const prefix = "x".repeat(85 * 2);
    const measure = (content: string): number => contentWeight(prefix + content);
    const items = [{ path: "log:///1/2/3/READ", tokens: 44 }];
    for (const budget of [100, 200]) {
        const rendered = BudgetReadout.resolve(BudgetReadout.draft(budget), measure, items).gauge;
        const usage = measure(rendered);
        assert.match(rendered, new RegExp(`"tokens":\\s*${usage},"budget":${budget}`, "u"), `the displayed figure retains the measured curation units; got: ${rendered}`);
        assert.doesNotMatch(rendered, /MUST/u);
    }
});

const SHARE = /^Context is at (\d+)% of budget\. YOU MUST NOT exceed budget\.$/u;

test("{§context-pressure-notice} a pressured packet within its budget carries one notice whose share is the gauge's own", () => {
    const items = [{ path: "log:///1/1/1/READ", tokens: 110 }];
    for (const base of [801, 850, 900]) {
        const { usage, gauge, notice } = resolve(1_000, base, items);
        assert.ok(notice !== null, `a packet of ${base} under a 1000 budget is under pressure`);
        assert.deepEqual({ source: notice.source, kind: notice.kind, level: notice.level }, { source: "engine:context", kind: "budget_pressure", level: "warn" });
        const share = SHARE.exec(notice.message ?? "")?.[1];
        assert.equal(Number(share), Math.floor(gauge.tokens * 100 / 1_000), "the share is the gauge's final tokens over its budget, the notice included");
        assert.equal(gauge.tokens, usage);
        assert.deepEqual(gauge.largest, items, "the notice arrives with the inventory");
    }
});

test("{§context-pressure-notice} no notice below pressure, without a budget, or over budget", () => {
    assert.equal(resolve(1_000, 700).notice, null, "below pressure");
    assert.equal(resolve(null, 100_000).notice, null, "an unknown budget");
    const over = resolve(1_000, 1_100, [{ path: "log:///1/1/1/READ", tokens: 110 }]);
    assert.ok(over.gauge.tokens > 1_000);
    assert.equal(over.notice, null, "over budget the row is the mandate ({§context-over-budget-row})");
    assert.equal(resolve(0, 0).notice, null, "a zero budget is over budget, never a share");
});

test("{§context-pressure-notice} a packet the notice would carry over its budget carries none", () => {
    const measure = (_gauge: string, notice: Notice | null): number => 990 + (notice === null ? 0 : 20);
    const readout = BudgetReadout.resolve(BudgetReadout.draft(1_000), measure);
    assert.equal(readout.notice, null);
    assert.deepEqual(JSON.parse(readout.gauge), { tokens: 990, budget: 1_000, largest: [] }, "the gauge still shows the pressure");
});

test("{§context-pressure-notice} the configured pressure threshold governs the notice", () => {
    const prior = process.env.PLURNK_SERVICE_BUDGET_PRESSURE;
    try {
        process.env.PLURNK_SERVICE_BUDGET_PRESSURE = "60%";
        assert.equal(resolve(1_000, 500).notice, null);
        assert.notEqual(resolve(1_000, 700).notice, null);
    } finally {
        if (prior === undefined) delete process.env.PLURNK_SERVICE_BUDGET_PRESSURE; else process.env.PLURNK_SERVICE_BUDGET_PRESSURE = prior;
    }
});

test("{§context-pressure-notice} the share converges when the notice's own weight moves it", () => {
    const prior = process.env.PLURNK_SERVICE_BUDGET_PRESSURE;
    try {
        process.env.PLURNK_SERVICE_BUDGET_PRESSURE = "5%";
        const measure = (_gauge: string, notice: Notice | null): number => 95 + (notice?.message?.length ?? 0);
        const readout = BudgetReadout.resolve(BudgetReadout.draft(1_000), measure);
        const tokens = (JSON.parse(readout.gauge) as Gauge).tokens;
        assert.equal(tokens, measure(readout.gauge, readout.notice));
        assert.equal(Number(SHARE.exec(readout.notice?.message ?? "")?.[1]), Math.floor(tokens * 100 / 1_000),
            "a share that crosses a digit boundary still equals the final count's");
    } finally {
        if (prior === undefined) delete process.env.PLURNK_SERVICE_BUDGET_PRESSURE; else process.env.PLURNK_SERVICE_BUDGET_PRESSURE = prior;
    }
});
