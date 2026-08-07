import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("the root pins the ordinary Node and npm toolchain", async () => {
    const manifest = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
    assert.equal(manifest.engines.node, ">=26");
    assert.equal(manifest.packageManager, "npm@11.18.0");
    assert.equal(manifest.scripts.prepare, "git config core.hooksPath .githooks && npm run build");
    assert.equal(manifest.scripts["config:list"], "node --conditions=plurnk-dev scripts/config-list.mjs");
    assert.equal(await readFile(new URL(".node-version", root), "utf8"), "26\n");
});
