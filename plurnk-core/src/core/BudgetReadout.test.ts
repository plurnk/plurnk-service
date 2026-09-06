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

test("BudgetReadout: the block opens as one JSON object whose total is the exact render-weight", () => {
    const { content, usage } = resolve(100_000, 100);
    assert.equal(content.split("\n").length, 1, "neutral telemetry is one JSON line");
    const parsed = JSON.parse(content) as { tokensActiveTotal: number; tokensActiveMax: number };
    assert.equal(parsed.tokensActiveTotal, usage);
    assert.equal(parsed.tokensActiveMax, 100_000);
});

test("BudgetReadout: decimal-width boundaries converge without off-by-one substitution", async (t) => {
    const cases = [
        { name: "two-digit total", ceiling: 100, baseWeight: 62 },
        { name: "total expands from two digits to three", ceiling: 200, baseWeight: 77 },
        { name: "small total under a wide ceiling", ceiling: 2_801, baseWeight: 0 },
        { name: "total overshoots a tiny ceiling", ceiling: 9, baseWeight: 62 },
        { name: "converted capacity cannot fit one curation unit", ceiling: 0, baseWeight: 62 },
    ] as const;

    for (const specimen of cases) {
        await t.test(specimen.name, () => {
            const { content, usage } = resolve(specimen.ceiling, specimen.baseWeight);
            const parsed = JSON.parse(content) as { tokensActiveTotal: number; tokensActiveMax: number };
            assert.equal(parsed.tokensActiveTotal, usage, "the displayed total is the exact render-weight");
            assert.equal(parsed.tokensActiveMax, specimen.ceiling);
        });
    }
});

test("BudgetReadout: over-ceiling pressure remains an honest telemetry object", () => {
    const { content, usage } = resolve(9, 62);
    assert.equal(content.split("\n").length, 1);
    const parsed = JSON.parse(content) as { tokensActiveTotal: number; tokensActiveMax: number };
    assert.equal(parsed.tokensActiveTotal, usage);
    assert.equal(parsed.tokensActiveMax, 9);
    assert.doesNotMatch(content, /tokensActiveLargest/u, "no inventory without candidate rows");
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
    assert.doesNotMatch(below.content, /"path":/u, "neutral telemetry omits the inventory below 80%");
    assert.doesNotMatch(below.content, /YOU MUST KILL/u, "the happy path retains only the stable SHOULD guidance");

    const pressured = resolve(1_500, 1_180, items);
    assert.match(
        pressured.content,
        /^\{"tokensActiveTotal":\s*\d+,"tokensActiveMax":1500,"tokensActiveLargest":\[/u,
        "the block opens as one JSON payload with the inventory folded in",
    );
    assert.match(
        pressured.content,
        /\]\}\n\nYOU MUST KILL superseded, stale, or irrelevant log items and ranges\.$/u,
        "the recovery mandate follows the JSON that names its targets",
    );
    const object = JSON.parse(pressured.content.split("\n\n")[0]!) as {
        tokensActiveTotal: number;
        tokensActiveLargest: ReadonlyArray<{ path: string; tokensBody: number; tokensActive: number }>;
    };
    assert.deepEqual(
        object.tokensActiveLargest,
        [
            { path: "log:///1/1/1/READ", tokensBody: 100, tokensActive: 110 },
            { path: "log:///1/1/2/READ", tokensBody: 100, tokensActive: 110 },
            { path: "log:///1/1/3/READ", tokensBody: 90, tokensActive: 100 },
            { path: "log:///1/1/4/READ", tokensBody: 80, tokensActive: 90 },
            { path: "log:///1/1/5/READ", tokensBody: 70, tokensActive: 80 },
        ],
        "rank by active cost, break ties by path, and bound the recovery index at five",
    );
    assert.equal(object.tokensActiveTotal, pressured.usage, "the displayed total includes the conditional inventory");
});

test("{§tokenomics-pressure-inventory}: recovery advice never creates an overflow", () => {
    const item = {
        path: `log:///${"1".repeat(200)}/READ`,
        tokensBody: 100,
        tokensActive: 110,
    };
    const pressured = resolve(1_000, 950, [item]);
    assert.doesNotMatch(pressured.content, /"path":/u, "an inventory that cannot fit is omitted");
    assert.doesNotMatch(pressured.content, /YOU MUST KILL/u, "the conditional mandate cannot manufacture an overflow either");
    assert.ok(pressured.usage <= 1_000, "the neutral packet remains admissible");
});

test("BudgetReadout: malformed templates and measurements fail at their owner", () => {
    assert.throws(
        () => BudgetReadout.resolve('{"tokensActiveMax":100}', 100, () => 10),
        /must contain \{\{tokensActiveTotal\}\} exactly once/,
    );
    assert.throws(
        () => BudgetReadout.resolve(BudgetReadout.draft(100), 100, () => Number.NaN),
        /packet weight must be a non-negative safe integer/,
    );
});

test("(#478) tokensResponseMax discloses the output allowance beside the ceiling", () => {
    const drafted = BudgetReadout.draft(1000, 8192);
    assert.match(drafted, /"tokensActiveMax":1000,"tokensResponseMax":8192/);
    assert.doesNotMatch(BudgetReadout.draft(1000, null), /tokensResponseMax/);
    assert.equal(BudgetReadout.draft(null, 8192), "");
    const content = BudgetReadout.resolve(drafted, 1000, (candidate) => candidate.length);
    assert.match(content, /"tokensResponseMax":8192/);
});

test("{§tokenomics-calibrated-readout} a converted ceiling changes pressure without changing cost units", () => {
    const ceiling = 100;
    const prefix = "x".repeat(85 * 2);
    const measure = (content: string): number => contentWeight(prefix + content);
    const items = [{ path: "log:///1/2/3/READ", tokensBody: 40, tokensActive: 44 }];
    const raw = BudgetReadout.resolve(BudgetReadout.draft(ceiling), ceiling, measure, items);
    assert.match(raw, /YOU MUST KILL superseded/u, "at factor 1 the raw weight sits above the pressure fraction and the mandate renders");
    const convertedCeiling = 200;
    const calibrated = BudgetReadout.resolve(BudgetReadout.draft(convertedCeiling), convertedCeiling, measure, items);
    const usage = measure(calibrated);
    assert.match(
        calibrated,
        new RegExp(`"tokensActiveTotal":\\s*${usage},`, "u"),
        `the displayed figure retains the measured curation units; got: ${calibrated}`,
    );
    assert.doesNotMatch(calibrated, /YOU MUST KILL/u, "the same packet under an honest factor carries no mandate");
});
