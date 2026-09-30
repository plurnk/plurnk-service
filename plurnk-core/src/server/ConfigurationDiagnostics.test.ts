import test from "node:test";
import assert from "node:assert/strict";
import { ConfigurationError } from "@plurnk/plurnk-meta";
import ConfigurationDiagnostics from "./ConfigurationDiagnostics.ts";

test("{§configuration-repair-path} configuration containment preserves valid values and exact operator diagnostics", async () => {
    const diagnostics = new ConfigurationDiagnostics();
    const config = { command: "fixture" };
    assert.equal(await diagnostics.capture("hooks", () => config), config);
    const error = new ConfigurationError("PLURNK_HOOKS_ARGS", "PLURNK_HOOKS_ARGS must be a JSON array of strings.");
    assert.equal(await diagnostics.capture("hooks", () => { throw error; }), null);
    assert.deepEqual(diagnostics.notices(), [{
        source: "engine:configuration", kind: "configuration_unavailable", level: "warn",
        family: "hooks", key: error.key, message: error.message,
    }]);
});

test("{§configuration-repair-path} internal failures cannot be contained as configuration errors", async () => {
    const diagnostics = new ConfigurationDiagnostics();
    const error = new Error("broken internal invariant");
    await assert.rejects(() => diagnostics.capture("hooks", async () => { throw error; }), (cause) => cause === error);
    assert.deepEqual(diagnostics.notices(), []);
});
