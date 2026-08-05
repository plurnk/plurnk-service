// {§exec-poll} — omitted cadence doubles for the configured steps, then holds.
import test from "node:test";
import assert from "node:assert/strict";
import { execPollBackoffMs } from "./exec-poll-backoff.ts";

test("{§exec-poll}: the default backoff doubles for `turns` steps then holds at the cap", () => {
    const base = 60, turns = 8;
    const secs = Array.from({ length: 12 }, (_, n) => execPollBackoffMs(n, base, turns) / 1000);
    // 60,120,240,480,960,1920,3840,7680 then HELD at 7680 (the ruling's exact ladder)
    assert.deepEqual(secs.slice(0, 8), [60, 120, 240, 480, 960, 1920, 3840, 7680], "the 8-step doubling ladder");
    assert.ok(secs.slice(8).every((s) => s === 7680), "held at the cap past `turns` — never blind, never reverting");
});

test("{§exec-poll}: the knobs retune base and ladder length", () => {
    assert.equal(execPollBackoffMs(0, 30, 4) / 1000, 30, "base honored");
    assert.equal(execPollBackoffMs(3, 30, 4) / 1000, 240, "cap at turns-1 (30·2^3)");
    assert.equal(execPollBackoffMs(9, 30, 4) / 1000, 240, "held past the shorter ladder");
});
