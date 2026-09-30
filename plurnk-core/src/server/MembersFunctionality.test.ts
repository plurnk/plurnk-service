// {§members-configuration} {§members-model-scope}
import test from "node:test";
import assert from "node:assert/strict";
import { aliasOf, modelScope, serviceMembers } from "./MembersFunctionality.ts";

test("{§members-configuration} declarations default enabled and per-alias switches override the family default", () => {
    const definitions = serviceMembers({
        PLURNK_MEMBERS_docs: "docs/**",
        PLURNK_MEMBERS_no_locks: "!**/*.lock",
        PLURNK_MEMBERS_no_locks_ENABLED: "0",
        PLURNK_MEMBERS_ENABLED: "1",
        OTHER_KEY: "x",
    });
    assert.deepEqual(definitions, [
        { alias: "docs", definition: { glob: "docs/**", provenance: { kind: "service-configuration", source: "PLURNK_MEMBERS_docs" } }, enabled: true },
        { alias: "no-locks", definition: { glob: "!**/*.lock", provenance: { kind: "service-configuration", source: "PLURNK_MEMBERS_no_locks" } }, enabled: false },
    ]);
    assert.deepEqual(serviceMembers({ PLURNK_MEMBERS_ENABLED: "1" }), []);
    assert.equal(serviceMembers({ PLURNK_MEMBERS_ENABLED: "0", PLURNK_MEMBERS_docs: "docs/**" })[0].enabled, false);
    assert.equal(serviceMembers({ PLURNK_MEMBERS_ENABLED: "0", PLURNK_MEMBERS_docs: "docs/**", PLURNK_MEMBERS_docs_ENABLED: "1" })[0].enabled, true);
    assert.throws(() => serviceMembers({}), /PLURNK_MEMBERS_ENABLED is missing from the assembled environment floor/u);
});

test("{§members-configuration} invalid patterns and controls fail by name", () => {
    assert.deepEqual(serviceMembers({ PLURNK_MEMBERS_nope_ENABLED: "0", PLURNK_MEMBERS_ENABLED: "1" }), [], "controls for future definitions do not manufacture members");
    assert.throws(() => serviceMembers({ PLURNK_MEMBERS_nope_ENABLED: "true", PLURNK_MEMBERS_ENABLED: "1" }), /PLURNK_MEMBERS_nope_ENABLED must be 0 or 1/u);
    assert.throws(() => serviceMembers({ PLURNK_MEMBERS_docs: "  ", PLURNK_MEMBERS_ENABLED: "1" }), /PLURNK_MEMBERS_docs must contain a definition/u);
    assert.throws(() => serviceMembers({ PLURNK_MEMBERS_none: "!", PLURNK_MEMBERS_ENABLED: "1" }), /PLURNK_MEMBERS_none names no pattern/u);
    assert.throws(() => serviceMembers({ PLURNK_MEMBERS_docs: "docs/**", PLURNK_MEMBERS_ENABLED: "[]" }), /PLURNK_MEMBERS_ENABLED must be 0 or 1/u);
    assert.throws(() => serviceMembers({ PLURNK_MEMBERS_docs: "docs/**", PLURNK_MEMBERS_docs_ENABLED: "true", PLURNK_MEMBERS_ENABLED: "1" }), /PLURNK_MEMBERS_docs_ENABLED must be 0 or 1/u);
});

test("{§members-configuration} noncanonical alias spellings cannot compete with canonical declarations", async (t) => {
    for (const invalid of ["PLURNK_MEMBERS_DOCS", "PLURNK_MEMBERS_Docs", "PLURNK_MEMBERS_no-locks"]) {
        for (const reverse of [false, true]) {
            await t.test(`${invalid}, reverse=${reverse}`, () => {
                const entries = [[invalid, "src/**"], ["PLURNK_MEMBERS_docs", "docs/**"]];
                assert.throws(() => serviceMembers({
                    PLURNK_MEMBERS_ENABLED: "1",
                    ...Object.fromEntries(reverse ? entries.toReversed() : entries),
                }), new RegExp(`${invalid} .*lowercase`, "u"));
            });
        }
    }
});

test("aliasOf suggests a legal alias from any glob; an exclusion is prefixed no-", () => {
    assert.equal(aliasOf("docs/**"), "docs");
    assert.equal(aliasOf(".env.local"), "env-local");
    assert.equal(aliasOf("!**/tokenizer.json"), "no-tokenizer-json");
    assert.equal(aliasOf("2024/*.md"), "p-2024-md");
});

test("{§members-model-scope} modelScope is the panel's word in the lattice, and an unset or empty key fails by name", () => {
    assert.throws(() => modelScope({}), /PLURNK_SERVICE_MEMBERS_MODEL_SCOPE must be one of none, root, namespace; got undefined/u);
    assert.throws(() => modelScope({ PLURNK_SERVICE_MEMBERS_MODEL_SCOPE: "" }), /PLURNK_SERVICE_MEMBERS_MODEL_SCOPE must be one of none, root, namespace/u);
    assert.equal(modelScope({ PLURNK_SERVICE_MEMBERS_MODEL_SCOPE: "none" }), "none");
    assert.equal(modelScope({ PLURNK_SERVICE_MEMBERS_MODEL_SCOPE: "root" }), "root");
    assert.throws(() => modelScope({ PLURNK_SERVICE_MEMBERS_MODEL_SCOPE: "wide" }), /PLURNK_SERVICE_MEMBERS_MODEL_SCOPE/u);
});
