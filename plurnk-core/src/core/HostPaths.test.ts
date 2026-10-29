import assert from "node:assert/strict";
import test from "node:test";
import HostPaths from "./HostPaths.ts";

test("{§execution-output-identity} a folder is spelled from the daemon's home: ~ for it, ~/ beneath it, absolute elsewhere", () => {
    const paths = new HostPaths({ home: "/home/tester", env: {} });
    for (const [folder, label] of [
        ["/home/tester", "~"],
        ["/home/tester/", "~"],
        ["/home/tester/ptl/project", "~/ptl/project"],
        ["/home/tester/ptl/../project", "~/project"],
        ["/home/tester/a b/ü √", "~/a b/ü √"],
        ["/home/tester2/project", "/home/tester2/project"],
        ["/home/testerx", "/home/testerx"],
        ["/srv/project", "/srv/project"],
        ["/", "/"],
    ]) assert.equal(paths.abbreviateUserPath(folder), label, folder);
});

test("{§share} an unset share folder is a stamped child of the XDG state shares folder", () => {
    const paths = new HostPaths({ home: "/home/tester", env: {} });
    const now = new Date("2026-09-26T15:04:05.678Z");
    assert.equal(paths.shareFolder({}, now), `${paths.stateDir}/shares/share-20260926T150405Z`);
});

test("{§share} a configured share folder expands a leading ~/ like every explicit Plurnk path", () => {
    const paths = new HostPaths({ home: "/home/tester", env: {} });
    const now = new Date("2026-09-26T15:04:05.678Z");
    assert.equal(paths.shareFolder({ PLURNK_SERVICE_SHARE_FOLDER: "~/benchmarks" }, now), "/home/tester/benchmarks/share-20260926T150405Z");
});

test("{§host-path-layout} forensic defaults honor the daemon's explicit database path", () => {
    const paths = new HostPaths({ home: "/home/tester", env: {} });
    assert.equal(paths.configuredDatabasePath({}), paths.databaseFile);
    assert.equal(paths.configuredDatabasePath({ PLURNK_SERVICE_DB_PATH: "~/evidence.db" }), "/home/tester/evidence.db");
});

test("{§host-path-layout} resolves the XDG defaults by artifact semantics", () => {
    const paths = new HostPaths({ env: {}, home: "/home/ada" });
    assert.equal(paths.configFile, "/home/ada/.config/plurnk/.env");
    assert.equal(paths.localConfigFile, "/home/ada/.config/plurnk/.env.local");
    assert.equal(paths.policyFile, "/home/ada/.config/plurnk/AGENTS.md");
    assert.equal(paths.localPolicyFile, "/home/ada/.config/plurnk/AGENTS.local.md");
    assert.equal(paths.xdgPolicyFile, "/home/ada/.config/agents/AGENTS.md");
    assert.equal(paths.xdgLocalPolicyFile, "/home/ada/.config/agents/AGENTS.local.md");
    assert.equal(paths.globalPolicyFile, "/home/ada/.agents/AGENTS.md");
    assert.equal(paths.globalLocalPolicyFile, "/home/ada/.agents/AGENTS.local.md");
    assert.deepEqual(paths.policyFiles, [
        "/home/ada/.config/agents/AGENTS.md",
        "/home/ada/.config/agents/AGENTS.local.md",
        "/home/ada/.agents/AGENTS.md",
        "/home/ada/.agents/AGENTS.local.md",
        "/home/ada/.config/plurnk/AGENTS.md",
        "/home/ada/.config/plurnk/AGENTS.local.md",
    ]);
    assert.equal(paths.databaseFile, "/home/ada/.local/share/plurnk/plurnk.db");
    assert.equal(paths.stateDir, "/home/ada/.local/state/plurnk");
    assert.equal(paths.cacheDir, "/home/ada/.cache/plurnk");
    assert.equal(paths.modelsCacheFile, "/home/ada/.cache/plurnk/models.json");
    assert.equal(paths.runtimeDir, null);
    assert.equal(paths.plurnkSkillsDir, "/home/ada/.config/plurnk/skills");
    assert.equal(paths.xdgAgentsDir, "/home/ada/.config/agents");
    assert.equal(paths.xdgSkillsDir, "/home/ada/.config/agents/skills");
    assert.equal(paths.globalSkillsDir, "/home/ada/.agents/skills");
    assert.equal(paths.projectSkillsDir("/work/repo"), "/work/repo/.agents/skills");
    assert.equal(paths.plurnkPluginsDir, "/home/ada/.config/plurnk/plugins");
    assert.equal(paths.xdgPluginsDir, "/home/ada/.config/agents/plugins");
    assert.equal(paths.globalPluginsDir, "/home/ada/.agents/plugins");
    assert.equal(paths.projectPluginsDir("/work/repo"), "/work/repo/.agents/plugins");
    assert.match(paths.pluginDataDir("devtools", "/plugins/devtools"), /^\/home\/ada\/\.local\/share\/plurnk\/plugins\/devtools\/[a-f0-9]{64}$/);
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
    assert.equal(paths.plurnkSkillsDir, "/cfg/plurnk/skills", "plurnk-only skills are configuration");
    assert.equal(paths.xdgSkillsDir, "/cfg/agents/skills", "XDG global skills follow XDG_CONFIG_HOME");
    assert.equal(paths.xdgPluginsDir, "/cfg/agents/plugins", "XDG global plugins follow XDG_CONFIG_HOME");
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
            XDG_STATE_HOME: "relative/state",
            XDG_CACHE_HOME: "relative/cache",
            XDG_RUNTIME_DIR: "relative/run",
        },
    });
    assert.equal(paths.configHome, "/home/ada/.config");
    assert.equal(paths.dataHome, "/home/ada/.local/share");
    assert.equal(paths.stateHome, "/home/ada/.local/state");
    assert.equal(paths.cacheHome, "/home/ada/.cache");
    assert.equal(paths.runtimeHome, null);
    assert.deepEqual(paths.invalidXdg, ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR"]);
});

test("{§host-path-layout} empty XDG homes use the same defaults as unset homes", () => {
    assert.deepEqual(new HostPaths({ home: "/home/ada", env: {
        XDG_CONFIG_HOME: "", XDG_DATA_HOME: "", XDG_STATE_HOME: "", XDG_CACHE_HOME: "", XDG_RUNTIME_DIR: "",
    } }), new HostPaths({ home: "/home/ada", env: {} }));
});

test("{§host-path-layout} an absolute state root moves data, state, cache and runtime — never configuration or the shared skills", () => {
    const paths = new HostPaths({ env: { PLURNK_SERVICE_STATE_ROOT: "/tmp/private-daemon", XDG_CONFIG_HOME: "/cfg", XDG_DATA_HOME: "/ignored-data" }, home: "/home/example" });
    assert.equal(paths.stateRoot, "/tmp/private-daemon");
    assert.equal(paths.dataDir, "/tmp/private-daemon/data/plurnk");
    assert.equal(paths.stateDir, "/tmp/private-daemon/state/plurnk");
    assert.equal(paths.cacheDir, "/tmp/private-daemon/cache/plurnk");
    assert.equal(paths.modelsCacheFile, "/tmp/private-daemon/cache/plurnk/models.json");
    assert.equal(paths.runtimeDir, "/tmp/private-daemon/runtime/plurnk");
    assert.equal(paths.databaseFile, "/tmp/private-daemon/data/plurnk/plurnk.db");
    assert.equal(paths.configDir, "/cfg/plurnk", "configuration is operator input and stays under XDG");
    assert.equal(paths.globalSkillsDir, "/home/example/.agents/skills", "the shared skills root stays under the home");
    assert.equal(paths.plurnkPluginsDir, "/cfg/plurnk/plugins", "installed plugins are configuration");
    assert.match(paths.pluginDataDir("devtools", "/plugins/devtools"), /^\/tmp\/private-daemon\/data\/plurnk\/plugins\/devtools\/[a-f0-9]{64}$/, "plugin data moves with the daemon's data");
    assert.deepEqual(paths.invalidXdg, [], "XDG homes the root replaces are not consulted");
});

test("{§host-path-layout} a leading ~/ expands and a relative root fails hard by name", () => {
    assert.equal(new HostPaths({ env: { PLURNK_SERVICE_STATE_ROOT: "~/runs/one" }, home: "/home/example" }).stateRoot, "/home/example/runs/one");
    assert.throws(() => new HostPaths({ env: { PLURNK_SERVICE_STATE_ROOT: "runs/one" }, home: "/home/example" }), /PLURNK_SERVICE_STATE_ROOT must be an absolute path/u);
    assert.equal(new HostPaths({ env: { PLURNK_SERVICE_STATE_ROOT: "" }, home: "/home/example" }).stateRoot, null, "empty is the XDG layout");
});

test("{§host-path-layout} expands only explicit Plurnk ~/ overrides", () => {
    const paths = new HostPaths({ env: {}, home: "/home/ada" });
    assert.equal(paths.expandUserPath("~"), "/home/ada");
    assert.equal(paths.expandUserPath("~/custom/plurnk.db"), "/home/ada/custom/plurnk.db");
    assert.equal(paths.expandUserPath("./plurnk.db"), "./plurnk.db");
});

test("{§host-path-layout} {§execution-output-identity} projectEnvironment replaces ambient HOME and XDG roots with the daemon's resolved layout", () => {
    const isolated = new HostPaths({ env: {}, home: "/tmp/isolated/home" });
    const projected = isolated.projectEnvironment({
        HOME: "/home/operator",
        XDG_CONFIG_HOME: "/home/operator/.config",
        XDG_DATA_HOME: "relative/invalid",
        XDG_RUNTIME_DIR: "/run/user/1000",
        PATH: "/usr/bin",
    });
    assert.equal(projected.HOME, "/tmp/isolated/home");
    assert.equal(projected.XDG_CONFIG_HOME, "/tmp/isolated/home/.config");
    assert.equal(projected.XDG_DATA_HOME, "/tmp/isolated/home/.local/share");
    assert.equal(projected.XDG_STATE_HOME, undefined, "unset XDG roots stay unset when the layout uses default XDG subtrees");
    assert.equal(projected.XDG_RUNTIME_DIR, undefined, "an absent runtimeHome strips any ambient XDG_RUNTIME_DIR");
    assert.equal(projected.PATH, "/usr/bin");

    const stateRooted = new HostPaths({
        home: "/home/example",
        env: { PLURNK_SERVICE_STATE_ROOT: "/tmp/private-daemon" },
    });
    const rootedEnv = stateRooted.projectEnvironment({ HOME: "/home/operator" });
    assert.equal(rootedEnv.HOME, "/home/example");
    assert.equal(rootedEnv.XDG_DATA_HOME, "/tmp/private-daemon/data");
    assert.equal(rootedEnv.XDG_STATE_HOME, "/tmp/private-daemon/state");
    assert.equal(rootedEnv.XDG_CACHE_HOME, "/tmp/private-daemon/cache");
    assert.equal(rootedEnv.XDG_RUNTIME_DIR, "/tmp/private-daemon/runtime");
});
