import test, { mock } from "node:test";
import { strict as assert } from "node:assert";
import { emitWarningOnce, resetEmittedWarnings } from "./warnings.ts";

test.afterEach(() => { mock.restoreAll(); resetEmittedWarnings(); });

test("#40: same (code, message) fires once per process", () => {
    const seen: string[] = [];
    mock.method(process, "emitWarning", (msg: string | Error) => { seen.push(String(msg)); });
    emitWarningOnce("openai provider: heuristic", "PLURNK_TOKENIZER_HEURISTIC");
    emitWarningOnce("openai provider: heuristic", "PLURNK_TOKENIZER_HEURISTIC");
    emitWarningOnce("openai provider: heuristic", "PLURNK_TOKENIZER_HEURISTIC");
    assert.deepEqual(seen, ["openai provider: heuristic"]);
});

test("#40: dedup is by (code, MESSAGE), not code — a second provider's surfacing is never suppressed", () => {
    const seen: string[] = [];
    mock.method(process, "emitWarning", (msg: string | Error) => { seen.push(String(msg)); });
    emitWarningOnce("openai provider: heuristic", "PLURNK_TOKENIZER_HEURISTIC");
    emitWarningOnce("groq provider: heuristic", "PLURNK_TOKENIZER_HEURISTIC"); // same code, different provider
    assert.deepEqual(seen, ["openai provider: heuristic", "groq provider: heuristic"]);
});

test("#40: resetEmittedWarnings clears the set (test-order independence)", () => {
    const seen: string[] = [];
    mock.method(process, "emitWarning", (msg: string | Error) => { seen.push(String(msg)); });
    emitWarningOnce("m", "C");
    resetEmittedWarnings();
    emitWarningOnce("m", "C");
    assert.equal(seen.length, 2);
});
