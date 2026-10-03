import test from "node:test";
import assert from "node:assert/strict";
import { ConfigurationError } from "@plurnk/plurnk-meta";
import TurnDispositionHandler from "./TurnDispositionHandler.ts";

test("{§worker-wait-timing} the maximum park has one positive configured duration", (t) => {
    const previous = process.env.PLURNK_SERVICE_WAIT_SEC;
    t.after(() => {
        if (previous === undefined) delete process.env.PLURNK_SERVICE_WAIT_SEC;
        else process.env.PLURNK_SERVICE_WAIT_SEC = previous;
    });
    for (const seconds of [1, 300, 600]) {
        process.env.PLURNK_SERVICE_WAIT_SEC = String(seconds);
        assert.equal(TurnDispositionHandler.configuredWaitSeconds(), seconds);
    }
    for (const invalid of ["0", "-1", "0.5", "later", ""]) {
        process.env.PLURNK_SERVICE_WAIT_SEC = invalid;
        assert.throws(() => TurnDispositionHandler.configuredWaitSeconds(), ConfigurationError);
    }
});

for (const key of ["PLURNK_SERVICE_EXEC_POLL_SEC", "PLURNK_SERVICE_EXEC_POLL_TURNS"]) {
    test(`{§worker-wait-timing} ${key} names its replacement instead of silently retaining a second policy`, (t) => {
        const previous = process.env[key];
        t.after(() => {
            if (previous === undefined) delete process.env[key];
            else process.env[key] = previous;
        });
        process.env[key] = "1";
        assert.throws(() => TurnDispositionHandler.configuredWaitSeconds(), (error: unknown) =>
            error instanceof ConfigurationError && error.message.includes(key) && error.message.includes("PLURNK_SERVICE_WAIT_SEC"));
    });
}
