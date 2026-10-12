// {§members-configuration} {§members-model-scope} {§members-projection}
import test from "node:test";
import assert from "node:assert/strict";
import { documentName, modelScope, serviceMembers } from "./MembersFunctionality.ts";

test("{§members-configuration} a declaration is named by its glob and keyed to its environment key; per-alias switches override the family default", () => {
    const definitions = serviceMembers({
        PLURNK_MEMBERS_docs: "docs/**",
        PLURNK_MEMBERS_no_locks: "!**/*.lock",
        PLURNK_MEMBERS_no_locks_ENABLED: "0",
        PLURNK_MEMBERS_ENABLED: "1",
        OTHER_KEY: "x",
    });
    assert.deepEqual(definitions, [
        { alias: "docs/**", definition: { glob: "docs/**", provenance: { kind: "service-configuration" } }, enabled: true, provenance: { kind: "environment", source: "PLURNK_MEMBERS_docs" } },
        { alias: "!**/*.lock", definition: { glob: "!**/*.lock", provenance: { kind: "service-configuration" } }, enabled: false, provenance: { kind: "environment", source: "PLURNK_MEMBERS_no_locks" } },
    ]);
    assert.deepEqual(serviceMembers({ PLURNK_MEMBERS_ENABLED: "1" }), []);
    assert.equal(serviceMembers({ PLURNK_MEMBERS_ENABLED: "0", PLURNK_MEMBERS_docs: "docs/**" })[0].enabled, false);
    assert.equal(serviceMembers({ PLURNK_MEMBERS_ENABLED: "0", PLURNK_MEMBERS_docs: "docs/**", PLURNK_MEMBERS_docs_ENABLED: "1" })[0].enabled, true);
    assert.throws(() => serviceMembers({}), /PLURNK_MEMBERS_ENABLED is missing from the assembled environment floor/u);
});

test("{§members-configuration} invalid patterns, controls and a glob declared twice fail by name", () => {
    assert.deepEqual(serviceMembers({ PLURNK_MEMBERS_nope_ENABLED: "0", PLURNK_MEMBERS_ENABLED: "1" }), [], "controls for future definitions do not manufacture members");
    assert.throws(() => serviceMembers({ PLURNK_MEMBERS_nope_ENABLED: "true", PLURNK_MEMBERS_ENABLED: "1" }), /PLURNK_MEMBERS_nope_ENABLED must be 0 or 1/u);
    assert.throws(() => serviceMembers({ PLURNK_MEMBERS_docs: "  ", PLURNK_MEMBERS_ENABLED: "1" }), /PLURNK_MEMBERS_docs must contain a definition/u);
    assert.throws(() => serviceMembers({ PLURNK_MEMBERS_none: "!", PLURNK_MEMBERS_ENABLED: "1" }), /PLURNK_MEMBERS_none names no pattern/u);
    assert.throws(() => serviceMembers({ PLURNK_MEMBERS_docs: "docs/**", PLURNK_MEMBERS_ENABLED: "[]" }), /PLURNK_MEMBERS_ENABLED must be 0 or 1/u);
    assert.throws(() => serviceMembers({ PLURNK_MEMBERS_docs: "docs/**", PLURNK_MEMBERS_docs_ENABLED: "true", PLURNK_MEMBERS_ENABLED: "1" }), /PLURNK_MEMBERS_docs_ENABLED must be 0 or 1/u);
    assert.throws(() => serviceMembers({ PLURNK_MEMBERS_docs: "docs/**", PLURNK_MEMBERS_guide: " docs/** ", PLURNK_MEMBERS_ENABLED: "1" }),
        /PLURNK_MEMBERS_guide repeats the definition 'docs\/\*\*' of PLURNK_MEMBERS_docs/u);
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

test("{§members-projection} a definition's document is its glob as one percent-encoded path segment; parentheses stay literal", () => {
    assert.equal(documentName("docs/**"), "docs%2F%2A%2A");
    assert.equal(documentName("!**/tokenizer.json"), "%21%2A%2A%2Ftokenizer.json");
    assert.equal(documentName("../shared/*.md"), "..%2Fshared%2F%2A.md");
    assert.equal(documentName("notes (draft)/[a-z]?.md"), "notes%20(draft)%2F%5Ba-z%5D%3F.md");
    assert.equal(documentName("plain-file_1.txt~"), "plain-file_1.txt~");
});

test("{§members-model-scope} modelScope is the panel's word in the lattice, and an unset or empty key fails by name", () => {
    assert.throws(() => modelScope({}), /PLURNK_SERVICE_MEMBERS_MODEL_SCOPE must be one of none, root, namespace; got undefined/u);
    assert.throws(() => modelScope({ PLURNK_SERVICE_MEMBERS_MODEL_SCOPE: "" }), /PLURNK_SERVICE_MEMBERS_MODEL_SCOPE must be one of none, root, namespace/u);
    assert.equal(modelScope({ PLURNK_SERVICE_MEMBERS_MODEL_SCOPE: "none" }), "none");
    assert.equal(modelScope({ PLURNK_SERVICE_MEMBERS_MODEL_SCOPE: "root" }), "root");
    assert.throws(() => modelScope({ PLURNK_SERVICE_MEMBERS_MODEL_SCOPE: "wide" }), /PLURNK_SERVICE_MEMBERS_MODEL_SCOPE/u);
});
