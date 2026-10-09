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
        owner: "hooks", key: error.key, message: error.message,
    }]);
});

test("{§configuration-repair-path} internal failures cannot be contained as configuration errors", async () => {
    const diagnostics = new ConfigurationDiagnostics();
    const error = new Error("broken internal invariant");
    await assert.rejects(() => diagnostics.capture("hooks", async () => { throw error; }), (cause) => cause === error);
    assert.deepEqual(diagnostics.notices(), []);
});

test("{§configuration-repair-path} repeated discovery diagnostics are deduplicated without turning shadowing into failure", () => {
    const diagnostics = new ConfigurationDiagnostics();
    const error = new ConfigurationError("fixture/plugin.json", "Broken native declaration.");
    diagnostics.record("extensions", error);
    diagnostics.record("extensions", error);
    const reports = [
        { root: "/plugins/shadowed", path: "", section: "client", outcome: "shadowed" as const, message: "A nearer definition wins." },
        { root: "/plugins/invalid", path: "mcp.json", section: "client", outcome: "invalid" as const, message: "Invalid configuration." },
    ];
    diagnostics.pluginReports(reports);
    diagnostics.pluginReports(reports);
    assert.deepEqual(diagnostics.notices().map(({ kind, level }) => ({ kind, level })), [
        { kind: "configuration_unavailable", level: "warn" },
        { kind: "plugin_configuration", level: "info" },
        { kind: "plugin_configuration", level: "warn" },
    ]);
});

test("{§operator-config-undeclared-key} an undeclared key is one warn notice naming the key and the file, recorded once", () => {
    const diagnostics = new ConfigurationDiagnostics();
    diagnostics.undeclared("PLURNK_FIXTURE_TYPO", "/home/operator/.config/plurnk/.env");
    diagnostics.undeclared("PLURNK_FIXTURE_TYPO", "/home/operator/.config/plurnk/.env");
    assert.deepEqual(diagnostics.notices(), [{
        source: "engine:configuration", kind: "configuration_undeclared", level: "info", key: "PLURNK_FIXTURE_TYPO",
        message: "`PLURNK_FIXTURE_TYPO` is set in /home/operator/.config/plurnk/.env and no installed package declares it.",
    }]);
});
