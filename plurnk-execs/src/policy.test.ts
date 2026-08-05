import test from "node:test";
import { strict as assert } from "node:assert";
import Policy from "./policy.ts";

test("{§executor-policy} #105: policy keys address canonical runtime tags and the ONLY control key", () => {
    for (const key of [
        "PLURNK_EXECS_SH",
        "PLURNK_EXECS_alias.tool",
        "plurnk_execs_TOOL-V2",
        "PLURNK_EXECS_C++",
        "PLURNK_EXECS_ONLY",
        "PLURNK_EXECS_only",
    ]) {
        assert.equal(Policy.isKey(key), true, `${key} is an addressable runtime policy key`);
    }
    for (const key of [
        "PLURNK_EXECS_",
        "PLURNK_EXECS_2FAST",
        "PLURNK_EXECS_ALIAS_TOOL",
        "PLURNK_EXECS_ERROR_DETAIL_LIMIT",
        "PLURNK_PROVIDERS_SH",
    ]) {
        assert.equal(Policy.isKey(key), false, `${key} is outside runtime policy-key grammar`);
    }
});

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

test("{§executor-policy} #162: an explicitly empty ONLY value is the empty allowlist", () => {
    assert.equal(Policy.isEnabled("node", {}), true, "an absent allowlist imposes no constraint");
    assert.equal(Policy.isEnabled("node", { PLURNK_EXECS_ONLY: "" }), false, "a present empty allowlist admits no tag");
    assert.equal(Policy.isEnabled("node", { PLURNK_EXECS_only: "" }), false, "case-insensitive key lookup preserves presence");
    assert.equal(
        Policy.enabledAcross("node", [{}, { PLURNK_EXECS_ONLY: "" }]),
        false,
        "an empty downstream layer remains subtractive in the intersection",
    );
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

test("isEnabled: the per-tag key is case-insensitive — lowercase behaves identically", () => {
    assert.equal(Policy.isEnabled("sh", { PLURNK_EXECS_SH: "0" }), false, "the uppercase key");
    assert.equal(Policy.isEnabled("sh", { PLURNK_EXECS_sh: "0" }), false, "…and the lowercase key no longer silently no-ops");
    assert.equal(Policy.isEnabled("node", { PLURNK_EXECS_Node: "false" }), false, "…and mixed case");
});

test("isEnabled: the PLURNK_EXECS_ONLY key is case-insensitive too", () => {
    assert.equal(Policy.isEnabled("node", { PLURNK_EXECS_only: "search" }), false, "a lowercase ONLY key still gates");
    assert.equal(Policy.isEnabled("search", { PLURNK_EXECS_only: "search" }), true);
});
