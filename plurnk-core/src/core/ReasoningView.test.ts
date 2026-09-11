import assert from "node:assert/strict";
import test from "node:test";
import { Mock } from "@plurnk/plurnk-providers";
import ReasoningView from "./ReasoningView.ts";
import ProviderInstantiate from "./ProviderInstantiate.ts";

test("{§reasoning-initial-read}: view limits use the selected alias and reject malformed configuration", () => {
    const keys = ["PLURNK_REASONING_VIEW_LINES", "PLURNK_REASONING_VIEW_LINES_viewtest"];
    const before = keys.map((key) => process.env[key]);
    const provider = new Mock({ contextWindow: 100_000, responses: [] });
    ProviderInstantiate.registerConfigurationScope(provider, "viewtest");
    try {
        process.env.PLURNK_REASONING_VIEW_LINES = "-1";
        delete process.env.PLURNK_REASONING_VIEW_LINES_viewtest;
        assert.equal(ReasoningView.lines(provider), -1);
        for (const value of ["0", "1", "8", "200"]) {
            process.env.PLURNK_REASONING_VIEW_LINES_viewtest = value;
            assert.equal(ReasoningView.lines(provider), Number(value));
        }
        process.env.PLURNK_REASONING_VIEW_LINES_viewtest = "";
        assert.equal(ReasoningView.lines(provider), -1, "an empty alias override is unset in the shared cascade");
        for (const value of ["1.5", "-2", "NaN", " 8 ", "9007199254740992"]) {
            process.env.PLURNK_REASONING_VIEW_LINES_viewtest = value;
            assert.throws(() => ReasoningView.lines(provider), /PLURNK_REASONING_VIEW_LINES must be -1, 0, or a positive integer\./);
        }
        delete process.env.PLURNK_REASONING_VIEW_LINES_viewtest;
        process.env.PLURNK_REASONING_VIEW_LINES = "";
        assert.throws(() => ReasoningView.lines(provider), /PLURNK_REASONING_VIEW_LINES must be/);
        delete process.env.PLURNK_REASONING_VIEW_LINES;
        assert.throws(() => ReasoningView.lines(provider), /PLURNK_REASONING_VIEW_LINES must be/);
        process.env.PLURNK_REASONING_VIEW_LINES = "-1";
        process.env.PLURNK_REASONING_VIEW_LINES_viewtest = "0";
        ProviderInstantiate.registerConfigurationScope(provider, null);
        assert.equal(ReasoningView.lines(provider), -1, "an exact route does not inherit another alias's cap");
    } finally {
        keys.forEach((key, index) => {
            if (before[index] === undefined) delete process.env[key];
            else process.env[key] = before[index];
        });
    }
});

test("{§reasoning-initial-read}: initialization reads its own source with the configured scope", () => {
    const before = process.env.PLURNK_REASONING_VIEW_LINES;
    const provider = new Mock({ contextWindow: 100_000, responses: [] });
    try {
        for (const limit of [-1, 0, 1, 8, 32]) {
            process.env.PLURNK_REASONING_VIEW_LINES = String(limit);
            const read = ReasoningView.initialRead(provider, 3, 8);
            if (limit === 0) assert.equal(read, null);
            else {
                assert.equal(read?.target?.raw, "reasoning:///3/8");
                assert.equal(read?.annotation, "inspect this turn's reasoning");
                assert.deepEqual(read?.lineMarker, { marks: [1, limit] });
            }
        }
    } finally {
        if (before === undefined) delete process.env.PLURNK_REASONING_VIEW_LINES;
        else process.env.PLURNK_REASONING_VIEW_LINES = before;
    }
});

test("{§reasoning-initial-read}: the authored rationale teaches the next model turn's current-source address", () => {
    assert.equal(ReasoningView.initialSource(3, 1), "This harness-generated turn surveys the workspace and available capabilities.\n"
        + "In turn 2, retain your reasoning in subsequent packets with:\n\n````READ (reasoning:///3/2) <1,-1>\n````");
});
