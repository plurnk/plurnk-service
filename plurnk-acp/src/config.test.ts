import assert from "node:assert/strict";
import test from "node:test";
import { resolveModuleOptions } from "./config.ts";

test("{§acp-configuration} resolveModuleOptions reads PLURNK_ACP_* from the assembled floor and accepts explicit overrides", () => {
    const resolved = resolveModuleOptions();
    assert.equal(resolved.allowOrigin, "*");
    assert.equal(resolved.maxTurns, undefined);
    assert.equal(resolved.heartbeatMs, 15000);
    assert.equal(resolved.historyLoops, 2);
    assert.equal(resolved.historyPageChars, 2000000);
    assert.equal(resolved.excerptChars, 240);
    assert.equal(resolved.overviewWorkers, 200);

    const overridden = resolveModuleOptions({
        allowOrigin: "https://client.example",
        maxTurns: 10,
        heartbeatMs: 0,
        historyLoops: 4,
        historyPageChars: 4096,
        excerptChars: 80,
        overviewWorkers: 25,
    });
    assert.deepEqual(overridden, {
        allowOrigin: "https://client.example",
        maxTurns: 10,
        heartbeatMs: 0,
        historyLoops: 4,
        historyPageChars: 4096,
        excerptChars: 80,
        overviewWorkers: 25,
    });

    assert.throws(() => resolveModuleOptions({ env: {} }), /PLURNK_ACP_ALLOW_ORIGIN is missing/u);
    assert.throws(() => resolveModuleOptions({ historyLoops: 0 }), /ModuleOptions\.historyLoops must be a safe integer/u);
});
