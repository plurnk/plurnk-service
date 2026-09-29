import assert from "node:assert/strict";
import test from "node:test";
import { hookConfig } from "./config.ts";
import { withEnvironment } from "../test/environment.ts";

const read = (env: NodeJS.ProcessEnv = {}) => withEnvironment(env, hookConfig);
const selected = { PLURNK_HOOKS_COMMAND: "node", PLURNK_HOOKS_EVENTS: "loop/terminated" };

test("{§hooks-config} hook configuration is absent until an exact command and event selection are declared", () => {
    assert.equal(read(), null);
    assert.throws(
        () => read({ PLURNK_HOOKS_COMMAND: "notify-send" }),
        /PLURNK_HOOKS_EVENTS must select at least one event/,
    );
    for (const companion of [{ PLURNK_HOOKS_EVENTS: "loop/terminated" }, { PLURNK_HOOKS_ARGS: "[]" }]) {
        assert.throws(() => read(companion), /has companions but no PLURNK_HOOKS_COMMAND/);
    }
});

test("{§hooks-config} production configuration preserves executable paths with spaces and exact JSON argv", () => {
    assert.deepEqual(read({
        PLURNK_HOOKS_COMMAND: "/opt/local tools/hook",
        PLURNK_HOOKS_ARGS: '["/opt/hooks/notify.mjs","literal;not-shell"]',
        PLURNK_HOOKS_EVENTS: "loop/terminated, notice/event",
        PLURNK_HOOKS_TIMEOUT_MS: "1200",
        PLURNK_HOOKS_CONCURRENCY: "2",
        PLURNK_HOOKS_QUEUE_LIMIT: "0",
    }), {
        command: "/opt/local tools/hook",
        args: ["/opt/hooks/notify.mjs", "literal;not-shell"],
        events: new Set(["loop/terminated", "notice/event"]),
        timeoutMs: 1200,
        concurrency: 2,
        queueLimit: 0,
    });
    assert.deepEqual(read(selected)?.args, []);
});

test("{§hooks-selection} selection uses exact core event names without a duplicated closed inventory", () => {
    const names = ["loop/packet", "loop/interaction", "workspace/preparation", "outside/event", "reasoning/event", "extension/event"];
    assert.deepEqual(read({ ...selected, PLURNK_HOOKS_EVENTS: names.join(",") })?.events, new Set(names));
    for (const events of ["notice/*", "notice", "loop/terminated,", "notice/ event", "notice/event,notice/event"]) {
        assert.throws(() => read({ ...selected, PLURNK_HOOKS_EVENTS: events }), /requires exact event names|more than once/);
    }
});

test("{§hooks-config} malformed argv and invalid delivery bounds fail configuration", () => {
    for (const args of ["--quiet", "{}", "[42]", "null"]) {
        assert.throws(() => read({ ...selected, PLURNK_HOOKS_ARGS: args }), /PLURNK_HOOKS_ARGS must be a JSON array of strings/);
    }
    for (const [name, invalid] of [
        ["PLURNK_HOOKS_TIMEOUT_MS", ["0", "-1", "", "1.5", "never"]],
        ["PLURNK_HOOKS_CONCURRENCY", ["0", "-1", "", "1.5"]],
        ["PLURNK_HOOKS_QUEUE_LIMIT", ["-1", "", "1.5"]],
    ] as const) {
        for (const value of invalid) {
            assert.throws(() => read({ ...selected, [name]: value }), new RegExp(`${name} must be a safe integer`));
        }
        withEnvironment(selected, () => {
            delete process.env[name];
            assert.throws(hookConfig, new RegExp(`${name} is missing from the assembled environment floor`));
        });
    }
});
