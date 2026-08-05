import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { resolveCandidateTopology } from "./candidate-topology.mjs";

const serviceRoot = "/open/plurnk-service";
const cwd = "/experiments/current";

test("candidate topology requires an explicit outside client checkout", () => {
    for (const value of [undefined, "", "   "]) {
        assert.throws(
            () => resolveCandidateTopology(serviceRoot, {
                ...(value === undefined ? {} : { PLURNK_CLIENT_CHECKOUT: value }),
            }, cwd),
            /PLURNK_CLIENT_CHECKOUT must name the outside open-client checkout/,
        );
    }
});

test("candidate topology defaults artifacts to the shared benchmark tree", () => {
    assert.deepEqual(
        resolveCandidateTopology(serviceRoot, {
            PLURNK_CLIENT_CHECKOUT: "../client",
            PLURNK_BENCHMARKS: " ",
            PLURNK_CANDIDATE_DIR: "",
        }, cwd),
        {
            clientRoot: resolve(cwd, "../client"),
            benchmarks: "/open/benchmarks",
            candidateDir: undefined,
        },
    );
});

test("candidate topology preserves explicit relative experiment overrides", () => {
    assert.deepEqual(
        resolveCandidateTopology(serviceRoot, {
            PLURNK_CLIENT_CHECKOUT: "  clients/open  ",
            PLURNK_BENCHMARKS: "../artifacts",
            PLURNK_CANDIDATE_DIR: "../artifacts/run7",
        }, cwd),
        {
            clientRoot: resolve(cwd, "clients/open"),
            benchmarks: resolve(cwd, "../artifacts"),
            candidateDir: resolve(cwd, "../artifacts/run7"),
        },
    );
});
