import test from "node:test";
import assert from "node:assert/strict";
import { exactSpecimen, liveFiles, liveInvocation } from "./live.mjs";
import { collectLiveTestNames, liveTimeoutMs } from "../test/live-test.ts";
import { failAfterCleanup } from "../test/live-failure.ts";

test("live and demo deadline reads the existing env knob and rejects invalid limits", (t) => {
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

test("the live catalog contains every registered specimen exactly once", async () => {
    const files = await liveFiles();
    const names = await collectLiveTestNames(files);
    assert.equal(names.length, 16);
    assert.equal(new Set(names).size, names.length);
});

test("the full tier and exact specimen share one invocation", async () => {
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

test("the specimen selector rejects absent and duplicate names", () => {
    assert.throws(() => exactSpecimen("missing", ["present"]), /matched 0 registered tests/);
    assert.throws(() => exactSpecimen("duplicate", ["duplicate", "duplicate"]), /matched 2 registered tests/);
});

test("live failure preserves cancellation failure without obscuring either cause", async () => {
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
