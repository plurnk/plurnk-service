import assert from "node:assert/strict";
import test from "node:test";
import { Mock } from "@plurnk/plurnk-providers";
import ReasoningView from "./ReasoningView.ts";
import ProviderInstantiate from "./ProviderInstantiate.ts";
import { UNKNOWN_POSITION, type ReadStatement } from "@plurnk/plurnk-contracts";

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

test("{§reasoning-initial-read}: pressure never widens a configured range", () => {
    for (const [limit, expected] of [[-1, 16], [1, 1], [8, 8], [16, 16], [32, 16]] as const) {
        const proposed: ReadStatement = {
            op: "READ", delimiter: "0", target: null, annotation: null,
            metadata: null, body: null, position: UNKNOWN_POSITION,
            lineMarker: { marks: [1, limit] },
        };
        assert.deepEqual(ReasoningView.bounded(proposed).lineMarker, { marks: [1, expected] });
        assert.deepEqual(proposed.lineMarker, { marks: [1, limit] });
    }
});
