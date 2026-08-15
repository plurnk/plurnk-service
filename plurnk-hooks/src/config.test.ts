import assert from "node:assert/strict";
import test from "node:test";
import { hookConfig, HOOK_EVENTS } from "./config.ts";

const floor = {
    PLURNK_HOOKS_TIMEOUT_MS: "30000",
};

test("hook configuration is absent until an exact command and event selection are declared", () => {
    assert.equal(hookConfig(floor), null);
    assert.throws(
        () => hookConfig({ ...floor, PLURNK_HOOKS_COMMAND: "notify-send" }),
        /PLURNK_HOOKS_EVENTS must select at least one event/,
    );
    assert.throws(
        () => hookConfig({ ...floor, PLURNK_HOOKS_EVENTS: "loop/terminated" }),
        /has companions but no PLURNK_HOOKS_COMMAND/,
    );
});

test("hook configuration preserves one executable, exact JSON argv, and selected core event names", () => {
    assert.deepEqual(hookConfig({
        ...floor,
        PLURNK_HOOKS_COMMAND: "/usr/bin/node",
        PLURNK_HOOKS_ARGS: '["/opt/hooks/notify.mjs","--quiet"]',
        PLURNK_HOOKS_EVENTS: "loop/terminated,notice/event",
    }), {
        command: "/usr/bin/node",
        args: ["/opt/hooks/notify.mjs", "--quiet"],
        events: new Set(["loop/terminated", "notice/event"]),
        timeoutMs: 30000,
    });
});

test("the event inventory is exactly the tagged core notification vocabulary", () => {
    assert.deepEqual(HOOK_EVENTS, [
        "log/entry",
        "loop/proposal",
        "loop/terminated",
        "notice/event",
        "stream/concluded",
        "stream/event",
        "workspace/branch-batch",
        "workspace/created",
    ]);
});

test("hook configuration rejects shell text, malformed argv, unknown events, duplicates, and invalid timeout", () => {
    const configured = {
        ...floor,
        PLURNK_HOOKS_COMMAND: "node hook.mjs",
        PLURNK_HOOKS_EVENTS: "loop/terminated",
    };
    assert.throws(() => hookConfig(configured), /must contain one executable/);
    assert.throws(
        () => hookConfig({ ...configured, PLURNK_HOOKS_COMMAND: "node", PLURNK_HOOKS_ARGS: "--quiet" }),
        /PLURNK_HOOKS_ARGS must be a JSON array of strings/,
    );
    assert.throws(
        () => hookConfig({ ...configured, PLURNK_HOOKS_COMMAND: "node", PLURNK_HOOKS_EVENTS: "turn/started" }),
        /unknown core event 'turn\/started'/,
    );
    assert.throws(
        () => hookConfig({ ...configured, PLURNK_HOOKS_COMMAND: "node", PLURNK_HOOKS_EVENTS: "notice/event,notice/event" }),
        /selects 'notice\/event' more than once/,
    );
    assert.throws(
        () => hookConfig({ ...configured, PLURNK_HOOKS_COMMAND: "node", PLURNK_HOOKS_TIMEOUT_MS: "0" }),
        /positive integer/,
    );
});
