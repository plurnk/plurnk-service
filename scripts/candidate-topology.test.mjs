import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import {
    resolveCandidateTopology,
    resolveClientCheckout,
    resolveExternalReposRoot,
} from "./project-topology.mjs";

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

test("the explicit client checkout is shared by candidate and release lifecycles", () => {
    assert.equal(
        resolveClientCheckout({ PLURNK_CLIENT_CHECKOUT: "../client" }, cwd),
        resolve(cwd, "../client"),
    );
});

test("release topology requires an explicit external repository forest", () => {
    assert.throws(
        () => resolveExternalReposRoot({}, cwd),
        /PLURNK_EXTERNAL_REPOS_ROOT must name the external repository forest/,
    );
    assert.equal(
        resolveExternalReposRoot({ PLURNK_EXTERNAL_REPOS_ROOT: "../forest" }, cwd),
        resolve(cwd, "../forest"),
    );
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
