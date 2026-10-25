import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalogSnapshot } from "@plurnk/plurnk-models";
import { exactSpecimen, liveFiles, liveInvocation } from "./live.mjs";
import { stampTierRun, tierArguments, tierEnvironment } from "./lib/tier.mjs";
import { compose, isSpecimenVerdict, render, workerRows } from "./lib/census-reporter.mjs";
import { censuses, history } from "./tier-history.mjs";
import { collectLiveSpecimens, collectLiveTestNames, liveTimeoutMs } from "../test/live-test.ts";
import { aliasesSatisfying, checkoutPath, onPath, parseRequirement, requirementsOfSkip, unmetRequirements } from "../test/live-requirements.ts";
import { failAfterCleanup } from "../test/live-failure.ts";
import { tierRunPath } from "../../scripts/lib/test-artifacts.ts";

test("{§live-harness-deadline} live and demo deadline reads the existing env knob and rejects invalid limits", (t) => {
    const previous = process.env.PLURNK_SERVICE_LIVE_TIMEOUT;
    t.after(() => {
        if (previous === undefined) delete process.env.PLURNK_SERVICE_LIVE_TIMEOUT;
        else process.env.PLURNK_SERVICE_LIVE_TIMEOUT = previous;
    });
    for (const limit of ["25", "900000"]) {
        process.env.PLURNK_SERVICE_LIVE_TIMEOUT = limit;
        assert.equal(liveTimeoutMs(), Number(limit));
    }
    for (const limit of ["0", "-1", "NaN", "1.5"]) {
        process.env.PLURNK_SERVICE_LIVE_TIMEOUT = limit;
        assert.throws(liveTimeoutMs, /must be a positive integer in milliseconds/);
    }
});

test("{§tier-census} the live catalog contains every registered specimen exactly once", async () => {
    const files = await liveFiles();
    const names = await collectLiveTestNames(files);
    assert.equal(names.length, 41);
    // {§tier-census} — the surfaces that were flags and scripts are specimens with requirements.
    assert.ok(names.includes("live mcp: current third-party stdio and HTTP servers compose through the assembled product"));
    assert.ok(names.includes("live client: the terminal client's real-model TUI tier passes against this service"));
    assert.ok(names.includes("live llama-server honors PLURNK's request-scoped reasoning allowance"));
    assert.ok(names.includes("live: the ACP client accepts the complete model response stream"));
    assert.ok(names.includes("live: discovery and model response traverse the in-process ACP module"));
    assert.ok(names.includes("live: full-text READ answers from the selected source lines"));
    assert.ok(names.includes("live: structural edits preserve neighboring source text"));
    assert.ok(names.includes("live: cancellation settles an active model request"));
    assert.ok(names.includes("{§bare-inference} live: delegate two isolated questions and consume their answers"));
    assert.ok(names.includes("live executor input: SEND feeds a running Node process"));
    assert.ok(names.includes("live: a client-attached image persists until log curation"));
    for (const form of ["hash", "line", "range", "insert", "column", "prepend", "append", "pattern", "whole"]) assert.ok(names.includes(`live: EDIT by ${form} — one taught EDIT lands the sentence that means it`), `the #893 ${form} specimen is registered`);
    for (const kind of ["image", "pdf", "audio"]) assert.ok(names.includes(`live: a retained ${kind} is reported as one earlier READ, never as a new arrival`), `the #899 ${kind} account specimen is registered`);
    assert.equal(new Set(names).size, names.length);
});

test("{§tier-specimen-selection} the full tier and exact specimen share one invocation", async () => {
    const full = await liveInvocation();
    const names = await collectLiveTestNames(await liveFiles());
    const specimen = await liveInvocation(names[0]);
    const patternIndex = specimen.args.indexOf("--test-name-pattern");
    assert.ok(patternIndex !== -1);
    assert.equal(specimen.args[patternIndex + 1], exactSpecimen(names[0], names));
    assert.deepEqual(
        specimen.args.filter((arg) => arg !== "--test-name-pattern" && arg !== specimen.args[patternIndex + 1]),
        full.args,
    );
    assert.deepEqual(specimen.env, full.env);
});

test("{§provider-conformance-matrix} the specimen selector rejects absent and duplicate names", () => {
    assert.throws(() => exactSpecimen("missing", ["present"]), /matched 0 registered tests/);
    assert.throws(() => exactSpecimen("duplicate", ["duplicate", "duplicate"]), /matched 2 registered tests/);
});

test("{§tier-census} a stamped run names its directory, adds the census reporter and stamps the child; an unstamped one does neither", async () => {
    assert.equal(stampTierRun("live", new Date("2026-10-12T23:59:59.123Z")), "live-20261012T235959Z");
    const files = ["/x/a.test.ts"];
    const stamped = tierArguments({ files, pattern: undefined, run: "live-20261012T235959Z" });
    const reporter = stamped.find((arg) => arg.startsWith("--test-reporter=") && arg.endsWith("census-reporter.mjs"));
    assert.ok(reporter, "the census reporter is configured");
    assert.equal(stamped[stamped.indexOf(reporter) + 1], `--test-reporter-destination=${join(tierRunPath("live-20261012T235959Z"), "census.md")}`);
    assert.ok(stamped.includes("--test-reporter=spec"), "the console keeps the spec reporter");
    const bare = tierArguments({ files, pattern: undefined, run: undefined });
    assert.ok(!bare.some((arg) => arg.endsWith("census-reporter.mjs")));
    assert.equal((await tierEnvironment("live-20261012T235959Z")).PLURNK_TIER_RUN, "live-20261012T235959Z");
    assert.equal((await tierEnvironment(undefined)).PLURNK_TIER_RUN, undefined);
});

test("{§tier-census} every specimen declares requirements from the closed vocabulary", async () => {
    const specimens = await collectLiveSpecimens(await liveFiles());
    for (const { name, requires } of specimens) {
        for (const requirement of requires) assert.doesNotThrow(() => parseRequirement(requirement), `${name} declares ${requirement}`);
    }
    assert.ok(specimens.some(({ requires }) => requires.includes("input:pdf")), "the pdf account specimen declares its modality");
    assert.throws(() => parseRequirement("vision"), /is not a live requirement/);
    assert.throws(() => parseRequirement("env:lowercase"), /is not a live requirement/);
    assert.throws(() => parseRequirement("url:ftp://x"), /is not a live requirement/);
    assert.throws(() => parseRequirement("bin:/usr/bin/uv"), /is not a live requirement/);
    assert.throws(() => parseRequirement("checkout:bench"), /is not a live requirement/);
});

test("{§tier-census} an unmet requirement is named with what the route or host showed; a met one is silent", async (t) => {
    const facts = async () => ({ inputModalities: new Set(["image"]), supportedEfforts: ["off", "adaptive"], outputBudget: null });
    const present = await mkdtemp(join(tmpdir(), "plurnk-checkout-"));
    t.after(() => rm(present, { recursive: true, force: true }));
    const env = { PRESENT: "1" };
    const probes = {
        url: async (url) => url.endsWith("/up"),
        bin: (name) => name === "npx",
        checkout: () => join(present, "missing"),
    };
    assert.deepEqual(await unmetRequirements(["input:image", "env:PRESENT", "url:https://example.test/up", "bin:npx", "checkout:client"], facts, env, { ...probes, checkout: () => present }), []);
    assert.deepEqual(await unmetRequirements(["input:pdf", "reasoning", "output-budget", "env:ABSENT", "url:https://example.test/down", "bin:uv", "checkout:client"], facts, env, probes), [
        "requires input:pdf: the route advertises image input",
        "requires reasoning: the route's efforts are off, adaptive",
        "requires output-budget: the route resolved no output budget",
        "requires env:ABSENT: ABSENT is not in the operator environment",
        "requires url:https://example.test/down: https://example.test/down did not answer within 10 s",
        "requires bin:uv: uv is not on PATH",
        `requires checkout:client: no client checkout at ${join(present, "missing")}; PLURNK_CLIENT_CHECKOUT names one`,
    ]);
    assert.equal(onPath("node"), true, "the running node is on PATH");
    assert.equal(onPath("no-such-binary-plurnk"), false);
    assert.equal(checkoutPath("client", { PLURNK_CLIENT_CHECKOUT: "/elsewhere/plurnk" }), "/elsewhere/plurnk");
    assert.ok(checkoutPath("client", {}).endsWith("/plurnk"), "the client's default is the sibling checkout");
    assert.deepEqual(requirementsOfSkip("requires input:pdf: the route advertises image input; requires reasoning: the route's efforts are off, adaptive"), ["input:pdf", "reasoning"]);
    assert.deepEqual(requirementsOfSkip("The selected route does not advertise native pdf input."), []);
});

test("{§tier-census} the catalog answers which declared aliases satisfy a route-bound requirement", () => {
    const snapshot = catalogSnapshot();
    const cataloged = (predicate) => {
        for (const [provider, models] of Object.entries(snapshot)) {
            for (const [model, info] of Object.entries(models)) if (predicate(info)) return { provider, model };
        }
        throw new Error("the catalog snapshot holds no such model");
    };
    const withPdf = cataloged((info) => info.modalities.input.includes("pdf"));
    const withoutPdf = cataloged((info) => !info.modalities.input.includes("pdf"));
    const aliases = [
        { alias: "pdfs", ...withPdf },
        { alias: "text", ...withoutPdf },
        { alias: "local", provider: "openai", model: "not-in-any-catalog.gguf" },
    ];
    assert.deepEqual(aliasesSatisfying("input:pdf", aliases), ["pdfs"]);
    assert.deepEqual(aliasesSatisfying("output-budget", aliases), ["pdfs", "text"], "a cataloged route resolves an output budget; an uncataloged one advertises nothing");
    assert.equal(aliasesSatisfying("env:BRAVE_API_KEY", aliases), null);
    assert.equal(aliasesSatisfying("url:https://example.test/", aliases), null);
    assert.equal(aliasesSatisfying("bin:uv", aliases), null);
    assert.equal(aliasesSatisfying("checkout:client", aliases), null);
});

test("{§tier-census} a census row is a specimen's own verdict, never a file's or a subtest's", () => {
    const file = "/x/a.test.ts";
    assert.ok(isSpecimenVerdict({ type: "test:pass", data: { name: "live: a", file, nesting: 0 } }));
    assert.ok(isSpecimenVerdict({ type: "test:fail", data: { name: "live: a", file, nesting: 0 } }));
    assert.ok(!isSpecimenVerdict({ type: "test:pass", data: { name: file, file, nesting: 0 } }), "a file reported as a pass under a name pattern");
    assert.ok(!isSpecimenVerdict({ type: "test:pass", data: { name: "inner", file, nesting: 1 } }), "a subtest");
    assert.ok(!isSpecimenVerdict({ type: "test:diagnostic", data: { nesting: 0, message: "x" } }));
});

test("{§tier-census} the census joins verdicts with the workers each specimen claimed and names unmet requirements; the history ledgers runs", async (t) => {
    const home = await mkdtemp(join(tmpdir(), "plurnk-census-"));
    t.after(() => rm(home, { recursive: true, force: true }));
    const dir = join(home, "tier-live-20261012T000000Z");
    const worker = (name, specimen, usd) => ({ specimen, label: name, runDir: join(dir, name), loops: 1, turns: 3, requests: 2, tokens: { input: 10, output: 5 }, cost: { usd, kinds: ["estimated"] } });
    for (const [name, specimen, usd] of [["live-a-AAAAAA", "a", 0.001], ["live-a-BBBBBB", "a", 0.002], ["live-stray-CCCCCC", null, 0]]) {
        await mkdir(join(dir, name), { recursive: true });
        await writeFile(join(dir, name, "census.json"), JSON.stringify(worker(name, specimen, usd)));
    }
    const workers = workerRows(dir);
    assert.deepEqual(workers.map(({ label }) => label), ["live-a-AAAAAA", "live-a-BBBBBB", "live-stray-CCCCCC"]);
    const census = compose({
        run: "live-20261012T000000Z", route: "deepdumb = deepseek/deepseek-flash",
        aliases: [{ alias: "local", provider: "openai", model: "x.gguf" }],
        tests: [
            { name: "a", file: "a.test.ts", verdict: "pass", reason: null, duration_ms: 1 },
            { name: "b", file: "b.test.ts", verdict: "skip", reason: "requires input:pdf: the route advertises image input", duration_ms: 1 },
            { name: "c", file: "c.test.ts", verdict: "fail", reason: "one is not two", duration_ms: 1 },
        ],
        workers, started: "2026-10-12T00:00:00.000Z", finished: "2026-10-12T00:01:00.000Z",
    });
    assert.deepEqual(census.totals, { pass: 1, fail: 1, skip: 1, todo: 0 });
    assert.deepEqual(census.specimens[0].workers, ["live-a-AAAAAA", "live-a-BBBBBB"]);
    assert.equal(census.specimens[0].turns, 6);
    assert.equal(census.specimens[0].usd, 0.003);
    assert.deepEqual(census.unattributed, ["live-stray-CCCCCC"]);
    assert.deepEqual(census.unmet, [{ requirement: "input:pdf", specimens: ["b"], satisfiedBy: [] }]);
    const markdown = render(census);
    assert.match(markdown, /\| skip \| b \| requires input:pdf: the route advertises image input \|/u);
    assert.match(markdown, /\| input:pdf \| 1 \| none declared \|/u);
    await writeFile(join(dir, "census.json"), JSON.stringify(census));
    const runs = censuses(home);
    assert.equal(runs.length, 1);
    const ledger = history(runs);
    assert.deepEqual(ledger.map(({ name, fail, skip }) => [name, fail, skip]), [["c", 1, 0], ["b", 0, 1], ["a", 0, 0]], "failures first, then skips, then by name");
    assert.equal(ledger[0].last.reason, "one is not two");
});

test("{§live-harness-deadline} live failure preserves cancellation failure without obscuring either cause", async () => {
    const primary = new Error("loop timed out");
    await assert.rejects(
        failAfterCleanup(primary, async () => {}),
        (error) => error === primary,
    );

    const cancellation = new Error("cancel transport failed");
    await assert.rejects(
        failAfterCleanup(primary, async () => { throw cancellation; }),
        (error) => error instanceof AggregateError
            && error.message === "live execution failed and cleanup also failed"
            && error.errors[0] === primary
            && error.errors[1] === cancellation,
    );
});
