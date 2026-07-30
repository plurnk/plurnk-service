import assert from "node:assert/strict";
import test from "node:test";
import { parseCandidateClientEnv } from "./candidate-env.mjs";

test("candidate client overrides parse one deterministic string map", () => {
    assert.deepEqual(
        parseCandidateClientEnv("{\"PLURNK_EXECS_ONLY\":\"atlas\"}"),
        { PLURNK_EXECS_ONLY: "atlas" },
    );
    assert.deepEqual(parseCandidateClientEnv(undefined), {});
});

test("candidate client overrides reject ambiguous values and daemon routing", () => {
    assert.throws(
        () => parseCandidateClientEnv("[]"),
        /JSON object with string values/,
    );
    assert.throws(
        () => parseCandidateClientEnv("{\"PLURNK_EXECS_ONLY\":1}"),
        /JSON object with string values/,
    );
    assert.throws(
        () => parseCandidateClientEnv("{\"PLURNK_PORT\":\"1\"}"),
        /candidate-owned daemon routing/,
    );
});
