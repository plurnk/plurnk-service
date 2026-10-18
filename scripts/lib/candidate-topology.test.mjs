import { homedir } from "node:os";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import {
    resolveCandidateTopology,
    resolveClientCheckout,
} from "./project-topology.mjs";

const serviceRoot = "/open/plurnk-service";
const cwd = "/experiments/current";

test("{§candidate-launcher} candidate topology requires an explicit outside client checkout", () => {
    for (const value of [undefined, "", "   "]) {
        assert.throws(
            () => resolveCandidateTopology(serviceRoot, {
                ...(value === undefined ? {} : { PLURNK_CLIENT_CHECKOUT: value }),
            }, cwd),
            /PLURNK_CLIENT_CHECKOUT must name the outside open-client checkout/,
        );
    }
});

test("{§candidate-launcher} the explicit client checkout is shared by candidate and release lifecycles", () => {
    assert.equal(
        resolveClientCheckout({ PLURNK_CLIENT_CHECKOUT: "../client" }, cwd),
        resolve(cwd, "../client"),
    );
});

test("{§candidate-launcher} conformance's sibling default applies only when no client checkout is supplied", () => {
    const sibling = resolve(serviceRoot, "../plurnk");
    for (const value of [undefined, "", "   "]) {
        assert.equal(resolveClientCheckout({ PLURNK_CLIENT_CHECKOUT: value }, cwd, sibling), sibling);
    }
    for (const value of ["../other client", "/independent/client", "/missing/client"]) {
        assert.equal(
            resolveClientCheckout({ PLURNK_CLIENT_CHECKOUT: ` ${value} ` }, cwd, sibling),
            resolve(cwd, value),
            "an explicit path overrides the default without guessing from filesystem availability",
        );
    }
});

test("{§test-artifact-retention} candidate topology defaults artifacts to the one benchmark home", () => {
    assert.deepEqual(
        resolveCandidateTopology(serviceRoot, {
            PLURNK_CLIENT_CHECKOUT: "../client",
            PLURNK_BENCHMARKS: " ",
            PLURNK_CANDIDATE_DIR: "",
        }, cwd),
        {
            clientRoot: resolve(cwd, "../client"),
            // {§test-artifact-retention} — the one benchmark home, as every harness resolves it.
            benchmarks: resolve(homedir(), "benchmarks"),
            candidateDir: undefined,
        },
    );
});

test("{§candidate-launcher} candidate topology preserves explicit relative experiment overrides", () => {
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
