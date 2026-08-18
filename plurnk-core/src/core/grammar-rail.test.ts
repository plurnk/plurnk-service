// {§grammar-rail-registration} — rail variants are built-in names or import
// specifiers: bare names resolve through @plurnk/plurnk-contracts subpaths,
// everything else through the Node resolution chain (operator file paths or
// third-party package export subpaths).

import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveGrammarRailPath } from "./TurnRunner.ts";

test("{§grammar-rail-registration}: a bare variant resolves to a built-in contracts subpath", () => {
    const path = resolveGrammarRailPath("plurnk.qwen.gbnf");
    assert.match(path, /plurnk-contracts[/\\]dist[/\\]plurnk\.qwen\.gbnf$/);
});

test("{§grammar-rail-registration}: an operator file path passes through verbatim", () => {
    const absolute = "/operator/rails/custom.gbnf";
    assert.equal(resolveGrammarRailPath(absolute), absolute);
    const relative = "./test/fixtures/rail.gbnf";
    assert.equal(resolveGrammarRailPath(relative), relative);
});

test("{§grammar-rail-registration}: a package export subpath resolves through the Node chain", async () => {
    // Resolve against the contracts package itself — any exported subpath is
    // enough to prove the specifier branch uses the resolution chain.
    const path = resolveGrammarRailPath("@plurnk/plurnk-contracts/plurnk.qwen.gbnf");
    assert.equal(path, fileURLToPath(import.meta.resolve("@plurnk/plurnk-contracts/plurnk.qwen.gbnf")));
});

test("{§grammar-rail-registration}: an unresolvable specifier throws, never degrading to unconstrained", () => {
    assert.throws(
        () => resolveGrammarRailPath("@acme/absent-rails/nope.gbnf"),
        (error: unknown) => error instanceof Error && /Cannot find package|Cannot find module/.test(error.message),
    );
});
