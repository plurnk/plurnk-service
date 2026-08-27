// {§members-configuration} {§members-model-scope} — the members family's own truths: the
// operator's definitions ride the PLURNK_MCP_* shape and a glob's alias is suggested from the
// glob. The ceiling is witnessed through the daemon (test/intg/members-functionality.test.ts).
import test from "node:test";
import assert from "node:assert/strict";
import { aliasOf, modelScope, serviceMembers } from "./MembersFunctionality.ts";

test("serviceMembers parses PLURNK_MEMBERS_<ALIAS> and PLURNK_MEMBERS_ENABLED; an exclusion rides in the glob", () => {
    const definitions = serviceMembers({
        PLURNK_MEMBERS_DOCS: "docs/**",
        PLURNK_MEMBERS_NO_LOCKS: "!**/*.lock",
        PLURNK_MEMBERS_ENABLED: "[\"docs\"]",
        OTHER_KEY: "x",
    });
    assert.deepEqual(definitions, [
        { alias: "docs", definition: { glob: "docs/**", provenance: { kind: "service-configuration", source: "PLURNK_MEMBERS_DOCS" } }, enabled: true },
        { alias: "no-locks", definition: { glob: "!**/*.lock", provenance: { kind: "service-configuration", source: "PLURNK_MEMBERS_NO_LOCKS" } }, enabled: false },
    ]);
    assert.deepEqual(serviceMembers({}), []);
});

test("serviceMembers fails hard on an unknown enabled alias, an empty glob, or a bare exclusion", () => {
    assert.throws(() => serviceMembers({ PLURNK_MEMBERS_DOCS: "docs/**", PLURNK_MEMBERS_ENABLED: "[\"nope\"]" }), /unknown members alias 'nope'/u);
    assert.throws(() => serviceMembers({ PLURNK_MEMBERS_DOCS: "  " }), /PLURNK_MEMBERS_DOCS names no pattern/u);
    assert.throws(() => serviceMembers({ PLURNK_MEMBERS_NONE: "!" }), /PLURNK_MEMBERS_NONE names no pattern/u);
    assert.throws(() => serviceMembers({ PLURNK_MEMBERS_DOCS: "docs/**", PLURNK_MEMBERS_ENABLED: "docs" }), /must be a JSON array/u);
});

test("aliasOf suggests a legal alias from any glob; an exclusion is prefixed no-", () => {
    assert.equal(aliasOf("docs/**"), "docs");
    assert.equal(aliasOf(".env.local"), "env-local");
    assert.equal(aliasOf("!**/tokenizer.json"), "no-tokenizer-json");
    assert.equal(aliasOf("2024/*.md"), "p-2024-md");
});

test("modelScope defaults to none and parses the lattice", () => {
    assert.equal(modelScope({}), "none");
    assert.equal(modelScope({ PLURNK_SERVICE_MEMBERS_MODEL_SCOPE: "" }), "none");
    assert.equal(modelScope({ PLURNK_SERVICE_MEMBERS_MODEL_SCOPE: "root" }), "root");
    assert.throws(() => modelScope({ PLURNK_SERVICE_MEMBERS_MODEL_SCOPE: "wide" }), /PLURNK_SERVICE_MEMBERS_MODEL_SCOPE/u);
});

