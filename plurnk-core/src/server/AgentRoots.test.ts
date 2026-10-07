import assert from "node:assert/strict";
import test from "node:test";
import HostPaths from "../core/HostPaths.ts";
import { workspacePaths } from "./AgentRoots.ts";

test("{§agent-roots} one root selection serves module files without moving configuration into a private state root", (t) => {
    const previous = process.env.PLURNK_SERVICE_ROOTS;
    t.after(() => { if (previous === undefined) delete process.env.PLURNK_SERVICE_ROOTS; else process.env.PLURNK_SERVICE_ROOTS = previous; });
    const paths = new HostPaths({ home: "/home/ada", env: { XDG_CONFIG_HOME: "/config", PLURNK_SERVICE_STATE_ROOT: "/isolated" } });
    process.env.PLURNK_SERVICE_ROOTS = "global,project,plurnk";
    const inherited = [{ scope: "plurnk", directory: "/config/plurnk" }, { scope: "global", directory: "/home/ada/.agents" }];
    assert.deepEqual(workspacePaths(paths, "/project"), {
        home: "/home/ada", projectRoot: "/project",
        configurationRoots: [{ scope: "project", directory: "/project/.agents" }, ...inherited],
    });
    assert.deepEqual(workspacePaths(paths, null), { home: "/home/ada", projectRoot: null, configurationRoots: inherited });
    process.env.PLURNK_SERVICE_ROOTS = "project";
    assert.deepEqual(workspacePaths(paths, null).configurationRoots, []);
    assert.deepEqual(workspacePaths(paths, "/project").configurationRoots, [{ scope: "project", directory: "/project/.agents" }]);
    process.env.PLURNK_SERVICE_ROOTS = "";
    assert.deepEqual(workspacePaths(paths, "/project").configurationRoots, []);
});
