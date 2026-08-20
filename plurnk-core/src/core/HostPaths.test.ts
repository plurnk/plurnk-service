import assert from "node:assert/strict";
import test from "node:test";
import HostPaths from "./HostPaths.ts";

test("{§host-path-layout} resolves the XDG defaults by artifact semantics", () => {
    const paths = new HostPaths({ env: {}, home: "/home/ada" });
    assert.equal(paths.configFile, "/home/ada/.config/plurnk/.env");
    assert.equal(paths.policyFile, "/home/ada/.config/plurnk/AGENTS.md");
    assert.equal(paths.databaseFile, "/home/ada/.local/share/plurnk/plurnk.db");
    assert.equal(paths.stateDir, "/home/ada/.local/state/plurnk");
    assert.equal(paths.cacheDir, "/home/ada/.cache/plurnk");
    assert.equal(paths.runtimeDir, null);
    assert.equal(paths.globalSkillsDir, "/home/ada/.agents/skills");
    assert.equal(paths.projectSkillsDir("/work/repo"), "/work/repo/.agents/skills");
    assert.equal(paths.legacyDir, "/home/ada/.plurnk");
});

test("{§host-path-layout} honors absolute XDG homes without moving the shared Agent Skills root", () => {
    const paths = new HostPaths({
        home: "/home/ada",
        env: {
            XDG_CONFIG_HOME: "/cfg",
            XDG_DATA_HOME: "/data",
            XDG_STATE_HOME: "/state",
            XDG_CACHE_HOME: "/cache",
            XDG_RUNTIME_DIR: "/run/user/1000",
        },
    });
    assert.equal(paths.configDir, "/cfg/plurnk");
    assert.equal(paths.dataDir, "/data/plurnk");
    assert.equal(paths.stateDir, "/state/plurnk");
    assert.equal(paths.cacheDir, "/cache/plurnk");
    assert.equal(paths.runtimeDir, "/run/user/1000/plurnk");
    assert.equal(paths.globalSkillsDir, "/home/ada/.agents/skills");
    assert.deepEqual(paths.invalidXdg, []);
});

test("{§host-path-layout} ignores relative XDG values instead of resolving them against CWD", () => {
    const paths = new HostPaths({
        home: "/home/ada",
        env: {
            XDG_CONFIG_HOME: "relative/config",
            XDG_DATA_HOME: "relative/data",
            XDG_RUNTIME_DIR: "relative/run",
        },
    });
    assert.equal(paths.configHome, "/home/ada/.config");
    assert.equal(paths.dataHome, "/home/ada/.local/share");
    assert.equal(paths.runtimeHome, null);
    assert.deepEqual(paths.invalidXdg, ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR"]);
});

test("{§host-path-layout} expands only explicit Plurnk ~/ overrides", () => {
    const paths = new HostPaths({ env: {}, home: "/home/ada" });
    assert.equal(paths.expandUserPath("~"), "/home/ada");
    assert.equal(paths.expandUserPath("~/custom/plurnk.db"), "/home/ada/custom/plurnk.db");
    assert.equal(paths.expandUserPath("./plurnk.db"), "./plurnk.db");
});
