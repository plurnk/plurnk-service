import test from "node:test";
import assert from "node:assert/strict";
import ResourceEnvironment from "./ResourceEnvironment.ts";

const vocabulary = { controls: ["TIMEOUT"], settings: ["TOOLS"] };
const read = (environment: Record<string, string | undefined>) => new ResourceEnvironment("PLURNK_FIXTURE_", vocabulary, environment);

test("{§resource-environment} lowercase declarations and uppercase controls are distinct and order-independent", () => {
    const entries = [
        ["PLURNK_FIXTURE_ENABLED", "1"],
        ["PLURNK_FIXTURE_code_search", '{"command":"search","args":["--local"]}'],
        ["PLURNK_FIXTURE_code_search_ENABLED", "0"],
        ["PLURNK_FIXTURE_enabled", "a resource named enabled"],
        ["PLURNK_FIXTURE_TIMEOUT", "10"],
        ["PLURNK_FIXTURE_code_search_TOOLS", '["find"]'],
        ["UNRELATED", "ignored"],
    ];
    for (const input of [entries, entries.toReversed()]) {
        const environment = read(Object.fromEntries(input));
        assert.deepEqual([...environment.definitions], [
            ["code-search", { key: "PLURNK_FIXTURE_code_search", value: '{"command":"search","args":["--local"]}' }],
            ["enabled", { key: "PLURNK_FIXTURE_enabled", value: "a resource named enabled" }],
        ]);
        assert.equal(environment.enabled("code-search"), false);
        assert.equal(environment.enabled("enabled"), true);
        assert.deepEqual(environment.setting("code-search", "TOOLS"), { key: "PLURNK_FIXTURE_code_search_TOOLS", value: '["find"]' });
    }
});

test("{§resource-environment} settings may precede definitions without manufacturing resources", () => {
    const environment = read({ PLURNK_FIXTURE_ENABLED: "0", PLURNK_FIXTURE_imported_ENABLED: "1" });
    assert.deepEqual([...environment.definitions], []);
    assert.equal(environment.enabled("imported"), true);
    assert.equal(environment.enabled("another"), false);
    const defined = read({ PLURNK_FIXTURE_ENABLED: "0", PLURNK_FIXTURE_imported_ENABLED: "1", PLURNK_FIXTURE_imported: "later definition" });
    assert.equal(defined.enabled("imported"), true);
    assert.deepEqual([...defined.definitions.keys()], ["imported"]);
});

test("{§resource-environment} empty definitions are invalid even when disabled; absent definitions remain absent", () => {
    for (const enabled of ["0", "1"]) {
        for (const value of ["", " \t\r\n"]) {
            assert.throws(() => read({ PLURNK_FIXTURE_ENABLED: enabled, PLURNK_FIXTURE_one: value, PLURNK_FIXTURE_one_ENABLED: "0" }), {
                message: "PLURNK_FIXTURE_one must contain a definition; use PLURNK_FIXTURE_one_ENABLED=0 to disable a defined resource.",
            });
        }
        const environment = read({ PLURNK_FIXTURE_ENABLED: enabled, PLURNK_FIXTURE_one: undefined });
        assert.deepEqual([...environment.definitions], []);
    }
});

test("{§resource-environment} invalid names, controls and switches fail without exposing definition data", () => {
    for (const key of ["PLURNK_FIXTURE_CODE_SEARCH", "PLURNK_FIXTURE_Code_Search", "PLURNK_FIXTURE_code-search", "PLURNK_FIXTURE_", "PLURNK_FIXTURE_9invalid"]) {
        assert.throws(() => read({ PLURNK_FIXTURE_ENABLED: "1", [key]: "private-definition" }), {
            message: `${key} is not a declared control; use a lowercase resource alias with underscores for hyphens and uppercase setting names.`,
        });
    }
    assert.throws(() => read({ PLURNK_FIXTURE_ENABLED: "1", PLURNK_FIXTURE_one_UNKNOWN: "private-definition" }), {
        message: "PLURNK_FIXTURE_one_UNKNOWN names unsupported resource setting 'UNKNOWN'.",
    });
    assert.throws(() => read({}), { message: "PLURNK_FIXTURE_ENABLED is missing from the assembled environment floor." });
    for (const value of ["[]", "true", "", "2"]) {
        assert.throws(() => read({ PLURNK_FIXTURE_ENABLED: value }), { message: `PLURNK_FIXTURE_ENABLED must be 0 or 1; got ${JSON.stringify(value)}.` });
        assert.throws(() => read({ PLURNK_FIXTURE_ENABLED: "1", PLURNK_FIXTURE_one_ENABLED: value }), {
            message: `PLURNK_FIXTURE_one_ENABLED must be 0 or 1; got ${JSON.stringify(value)}.`,
        });
    }
});
