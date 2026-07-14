import { test } from "node:test";
import assert from "node:assert/strict";
import { name } from "./index.ts";

test("scaffold exposes its package name", () => {
    assert.equal(name, "@plurnk/plurnk-plurnkdown");
});
