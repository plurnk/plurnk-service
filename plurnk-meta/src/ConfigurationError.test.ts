import test from "node:test";
import assert from "node:assert/strict";
import ConfigurationError from "./ConfigurationError.ts";

// Another copy of this package, as a module's own plugin root carries it: the same shape, another class.
class CopiedConfigurationError extends Error {
    readonly key: string;

    constructor(key: string, message: string) {
        super(message);
        this.name = "ConfigurationError";
        this.key = key;
    }
}

test("{§configuration-error-identity} a configuration error is recognized by its name and key, whichever copy made it", () => {
    const named = Object.assign(new Error("PLURNK_X: no key"), { name: "ConfigurationError" });
    const keyed = Object.assign(new Error("PLURNK_X: other error"), { key: "PLURNK_X" });
    const cases: ReadonlyArray<readonly [string, unknown, boolean]> = [
        ["this copy's error", new ConfigurationError("PLURNK_X", "PLURNK_X: invalid"), true],
        ["another copy's error", new CopiedConfigurationError("PLURNK_X", "PLURNK_X: invalid"), true],
        ["an error named ConfigurationError without a key", named, false],
        ["an error with a key and another name", keyed, false],
        ["an ordinary error", new Error("internal"), false],
        ["a plain object with the name and key", { name: "ConfigurationError", key: "PLURNK_X", message: "" }, false],
        ["null", null, false],
    ];
    for (const [label, value, expected] of cases) assert.equal(value instanceof ConfigurationError, expected, label);
});
