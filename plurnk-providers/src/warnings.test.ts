import test, { mock } from "node:test";
import { strict as assert } from "node:assert";
import { emitWarningOnce, resetEmittedWarnings } from "./warnings.ts";

test.afterEach(() => { mock.restoreAll(); resetEmittedWarnings(); });

test("same (code, message) fires once per process", () => {
    const seen: string[] = [];
    mock.method(process, "emitWarning", (msg: string | Error) => { seen.push(String(msg)); });
    emitWarningOnce("openai provider: estimate", "PLURNK_PROMPT_COUNT_ESTIMATE");
    emitWarningOnce("openai provider: estimate", "PLURNK_PROMPT_COUNT_ESTIMATE");
    emitWarningOnce("openai provider: estimate", "PLURNK_PROMPT_COUNT_ESTIMATE");
    assert.deepEqual(seen, ["openai provider: estimate"]);
});

test("dedup is by (code, MESSAGE), not code — a second provider's surfacing is never suppressed", () => {
    const seen: string[] = [];
    mock.method(process, "emitWarning", (msg: string | Error) => { seen.push(String(msg)); });
    emitWarningOnce("openai provider: estimate", "PLURNK_PROMPT_COUNT_ESTIMATE");
    emitWarningOnce("groq provider: estimate", "PLURNK_PROMPT_COUNT_ESTIMATE"); // same code, different provider
    assert.deepEqual(seen, ["openai provider: estimate", "groq provider: estimate"]);
});

test("resetEmittedWarnings clears the set (test-order independence)", () => {
    const seen: string[] = [];
    mock.method(process, "emitWarning", (msg: string | Error) => { seen.push(String(msg)); });
    emitWarningOnce("m", "C");
    resetEmittedWarnings();
    emitWarningOnce("m", "C");
    assert.equal(seen.length, 2);
});
