import assert from "node:assert/strict";
import test from "node:test";
import { configDeclarations, formatConfigInventory } from "./config-list.mjs";

test("the configuration inventory reports ownership and source classes without values", () => {
    const declarations = configDeclarations([
        {
            owner: "@plurnk/alpha",
            parsed: { PLURNK_ALPHA: "sensitive-default" },
            text: "PLURNK_ALPHA=sensitive-default\n# PLURNK_ALPHA_OPTIONAL=example\n# Empty = no default\n",
        },
        {
            owner: "@plurnk/beta",
            parsed: { PLURNK_BETA: "private-default" },
            text: "PLURNK_BETA=private-default\n",
        },
    ]);
    const output = formatConfigInventory(declarations, { PLURNK_BETA: "operator-value" });
    assert.equal(output, [
        "SOURCE PRECEDENCE (LOW→HIGH)\tpackage .env.defaults floor < ~/.plurnk/.env < ./.env < explicit env file < process environment < CLI flag",
        "KEY\tOWNER\tDECLARATION\tCOMMAND SOURCE",
        "PLURNK_ALPHA\t@plurnk/alpha\tdefault\tpackage default",
        "PLURNK_ALPHA_OPTIONAL\t@plurnk/alpha\toptional\tunset",
        "PLURNK_BETA\t@plurnk/beta\tdefault\tprocess environment",
        "",
    ].join("\n"));
    assert.doesNotMatch(output, /sensitive-default|private-default|operator-value/);
    assert.doesNotMatch(output, /^Empty\t/m);
});

test("optional declarations obey the same one-owner rule", () => {
    assert.throws(
        () => configDeclarations([
            { owner: "a", parsed: {}, text: "# PLURNK_SHARED=one\n" },
            { owner: "b", parsed: {}, text: "# PLURNK_SHARED=two\n" },
        ]),
        /PLURNK_SHARED is declared by both a and b/,
    );
});
