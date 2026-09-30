import assert from "node:assert/strict";
import test from "node:test";
import HostPaths from "../core/HostPaths.ts";
import { configurationDirectories } from "./AgentRoots.ts";

test("{§agent-roots} one root selection serves module files without moving configuration into a private state root", (t) => {
    const previous = process.env.PLURNK_SERVICE_ROOTS;
    t.after(() => { if (previous === undefined) delete process.env.PLURNK_SERVICE_ROOTS; else process.env.PLURNK_SERVICE_ROOTS = previous; });
    const paths = new HostPaths({ home: "/home/ada", env: { XDG_CONFIG_HOME: "/config", PLURNK_SERVICE_STATE_ROOT: "/isolated" } });
    process.env.PLURNK_SERVICE_ROOTS = "global,project,plurnk";
    assert.deepEqual(configurationDirectories(paths, "/project"), ["/project/.agents", "/config/plurnk", "/home/ada/.agents"]);
    assert.deepEqual(configurationDirectories(paths, null), ["/config/plurnk", "/home/ada/.agents"]);
    process.env.PLURNK_SERVICE_ROOTS = "project";
    assert.deepEqual(configurationDirectories(paths, null), []);
    assert.deepEqual(configurationDirectories(paths, "/project"), ["/project/.agents"]);
    process.env.PLURNK_SERVICE_ROOTS = "";
    assert.deepEqual(configurationDirectories(paths, "/project"), []);
});
