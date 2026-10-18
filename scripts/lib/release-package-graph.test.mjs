import assert from "node:assert/strict";
import test from "node:test";
import { candidateGraph, publicationOrder } from "./release-package-graph.mjs";

const pkg = (name, version, fields = {}) => ({ name, version, ...fields });

test("{§release-candidate-graph} each dependency is checked against its own version, not a platform stamp", () => {
    const packages = [
        pkg("service", "2.4.0", { dependencies: { framework: "^3.1.0", extension: "2.0.1" } }),
        pkg("framework", "3.2.0"),
        pkg("extension", "2.0.1", { peerDependencies: { framework: ">=3.1.0 <4" } }),
    ];
    const graph = candidateGraph(packages);
    assert.deepEqual(publicationOrder(graph).map(({ name }) => name), ["framework", "extension", "service"]);
});

test("{§release-candidate-graph} an absent independent product is not inspected or required", () => {
    const graph = candidateGraph([pkg("hooks", "2.0.1", { peerDependencies: { modules: "^2.0.0" } })]);
    assert.deepEqual(publicationOrder(graph).map(({ name }) => name), ["hooks"]);
});

test("{§release-candidate-graph} invalid candidate edges identify the exact consumer and incompatible dependency", () => {
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"]) {
        assert.throws(() => candidateGraph([
            pkg("extension", "2.0.0", { [field]: { framework: "^1.0.0" } }),
            pkg("framework", "2.0.0"),
        ]), new RegExp(`extension@2\\.0\\.0: ${field}\\.framework@\\^1\\.0\\.0 excludes candidate 2\\.0\\.0`));
    }
});

test("{§release-candidate-graph} compatibility uses ordinary SemVer ranges and does not require matching majors", () => {
    for (const range of ["^2.0.0", "~2.1.0", ">=2 <3", "^1 || ^2", "2.1.3"]) {
        assert.doesNotThrow(() => candidateGraph([
            pkg("consumer", "7.0.0", { dependencies: { framework: range } }), pkg("framework", "2.1.3"),
        ]));
    }
});

test("{§release-candidate-graph} duplicate identities and invalid package versions fail before publication", () => {
    assert.throws(() => candidateGraph([pkg("one", "2.0.0"), pkg("one", "2.1.0")]), /duplicate candidate package one/);
    assert.throws(() => candidateGraph([pkg("one", "next")]), /one: invalid package version/);
    for (const version of ["2.0.0-beta.1", "2.0.0+build", "v2.0.0"]) {
        assert.throws(() => candidateGraph([pkg("one", version)]), /expected stable major.minor.patch/);
    }
});

test("{§release-candidate-graph} build-only edges do not introduce runtime publication cycles", () => {
    const graph = candidateGraph([
        pkg("framework", "2.0.0", { devDependencies: { grammar: "2.0.0" } }),
        pkg("grammar", "2.0.0", { peerDependencies: { framework: "^2.0.0" } }),
    ]);
    assert.deepEqual(publicationOrder(graph).map(({ name }) => name), ["framework", "grammar"]);
});

test("{§release-candidate-graph} a runtime dependency cycle names the path and cannot publish partially", () => {
    assert.throws(() => publicationOrder(candidateGraph([
        pkg("one", "2.0.0", { dependencies: { two: "^2.0.0" } }),
        pkg("two", "2.0.0", { dependencies: { one: "^2.0.0" } }),
    ])), /publication cycle: one -> two -> one/);
});
