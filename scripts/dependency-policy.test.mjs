// ARCHITECTURE.md § Package principles — the package graph is refused by name when it cycles or
// depends toward instability (#1008).
import test from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs/promises";
import path from "node:path";
import { packageGraphViolations } from "./dependency-policy.mjs";

const range = (names) => Object.fromEntries(names.map((name) => [`@plurnk/${name}`, "^1.0.0"]));
const workspace = (name, dependencies = [], peerDependencies = []) => ({
    file: `${name}/package.json`,
    manifest: { name: `@plurnk/${name}`, dependencies: range(dependencies), peerDependencies: range(peerDependencies) },
});

test("a layered graph keeps both principles", () => {
    assert.deepEqual(packageGraphViolations([
        workspace("contracts"),
        workspace("schemes", ["contracts"]),
        workspace("leaf", [], ["schemes"]),
        workspace("service", ["contracts", "schemes", "leaf"]),
    ]), []);
});

test("a host its plugin imports closes a cycle, refused by name", () => {
    const violations = packageGraphViolations([
        workspace("contracts"),
        workspace("hooks", ["contracts"], ["service"]),
        workspace("service", ["contracts", "hooks"]),
    ]);
    assert.ok(
        violations.includes("package cycle among @plurnk/hooks, @plurnk/service, against the Acyclic Dependencies principle (ARCHITECTURE.md § Package principles)"),
        violations.join("\n"),
    );
});

test("an API that depends on a less stable package is refused naming the edge", () => {
    // Two leaves depend on api, which depends on impl; impl depends on two packages nobody else uses.
    const violations = packageGraphViolations([
        workspace("contracts"),
        workspace("util"),
        workspace("impl", ["contracts", "util"]),
        workspace("api", ["impl"]),
        workspace("left", ["api"]),
        workspace("right", ["api"]),
    ]);
    assert.deepEqual(violations, [
        "api/package.json: dependencies.@plurnk/impl is less stable than this package (instability 2/3 against 1/3), against the Stable Dependencies principle (ARCHITECTURE.md § Package principles)",
    ]);
});

test("development dependencies are not package-graph edges", () => {
    const fixture = workspace("contracts");
    fixture.manifest.devDependencies = range(["service"]);
    assert.deepEqual(packageGraphViolations([fixture, workspace("service", ["contracts"])]), []);
});

test("the repository's own package graph keeps both principles", async () => {
    const root = path.resolve(import.meta.dirname, "..");
    const { workspaces } = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
    const entries = await Promise.all(workspaces.map(async (dir) => ({
        file: `${dir}/package.json`,
        manifest: JSON.parse(await fs.readFile(path.join(root, dir, "package.json"), "utf8")),
    })));
    assert.deepEqual(packageGraphViolations(entries), []);
});
