import test from "node:test";
import { strict as assert } from "node:assert";
import Policy from "./policy.ts";

test("isEnabled: a tag is on by default when nothing is set", () => {
    assert.equal(Policy.isEnabled("node", {}), true);
});

test("isEnabled: PLURNK_EXECS_<TAG>=0 / =false kills one tag; any other value leaves it on", () => {
    assert.equal(Policy.isEnabled("node", { PLURNK_EXECS_NODE: "0" }), false);
    assert.equal(Policy.isEnabled("node", { PLURNK_EXECS_NODE: "false" }), false);
    assert.equal(Policy.isEnabled("node", { PLURNK_EXECS_NODE: "FALSE" }), false);
    assert.equal(Policy.isEnabled("node", { PLURNK_EXECS_NODE: "1" }), true);
});

test("isEnabled: PLURNK_EXECS_ONLY is an allowlist — everything not listed is off", () => {
    const env = { PLURNK_EXECS_ONLY: "search, sqlite" };
    assert.equal(Policy.isEnabled("search", env), true);
    assert.equal(Policy.isEnabled("sqlite", env), true);
    assert.equal(Policy.isEnabled("node", env), false, "not in the allowlist → disabled");
});

test("isEnabled: the allowlist and tag match are case-insensitive", () => {
    assert.equal(Policy.isEnabled("SEARCH", { PLURNK_EXECS_ONLY: "search" }), true);
    assert.equal(Policy.isEnabled("search", { PLURNK_EXECS_ONLY: "SEARCH" }), true);
});

test("isEnabled: ONLY and per-tag compose — an allowlisted tag can still be individually killed", () => {
    const env = { PLURNK_EXECS_ONLY: "search,node", PLURNK_EXECS_NODE: "0" };
    assert.equal(Policy.isEnabled("search", env), true);
    assert.equal(Policy.isEnabled("node", env), false, "allowlisted but individually disabled");
});

test("enabledAcross: the cascade is an intersection — enabled iff on in EVERY layer", () => {
    const service = { PLURNK_EXECS_ONLY: "search,sqlite" };
    const client = { PLURNK_EXECS_ONLY: "search" };
    assert.equal(Policy.enabledAcross("search", [service, client]), true);
    assert.equal(Policy.enabledAcross("sqlite", [service, client]), false, "the client narrowed it away");
});

test("enabledAcross: the client CANNOT re-enable what the service disabled", () => {
    const service = { PLURNK_EXECS_NODE: "0" };           // service kills node
    const client = { PLURNK_EXECS_ONLY: "node,search" };  // client tries to allow it back
    assert.equal(Policy.enabledAcross("node", [service, client]), false, "the service disable is the ceiling");
    assert.equal(Policy.enabledAcross("search", [service, client]), true);
});
