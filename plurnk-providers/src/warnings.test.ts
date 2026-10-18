import test, { mock } from "node:test";
import { strict as assert } from "node:assert";
import { emitWarningOnce, resetEmittedWarnings } from "./warnings.ts";

test.afterEach(() => { mock.restoreAll(); resetEmittedWarnings(); });

test("{§provider-prompt-measurement} same (code, message) fires once per process", () => {
    const seen: string[] = [];
    mock.method(process, "emitWarning", (msg: string | Error) => { seen.push(String(msg)); });
    emitWarningOnce("openai provider: estimate", "PLURNK_PROMPT_COUNT_ESTIMATE");
    emitWarningOnce("openai provider: estimate", "PLURNK_PROMPT_COUNT_ESTIMATE");
    emitWarningOnce("openai provider: estimate", "PLURNK_PROMPT_COUNT_ESTIMATE");
    assert.deepEqual(seen, ["openai provider: estimate"]);
});

test("{§provider-prompt-measurement} dedup is by (code, MESSAGE), not code — a second provider's surfacing is never suppressed", () => {
    const seen: string[] = [];
    mock.method(process, "emitWarning", (msg: string | Error) => { seen.push(String(msg)); });
    emitWarningOnce("openai provider: estimate", "PLURNK_PROMPT_COUNT_ESTIMATE");
    emitWarningOnce("groq provider: estimate", "PLURNK_PROMPT_COUNT_ESTIMATE"); // same code, different provider
    assert.deepEqual(seen, ["openai provider: estimate", "groq provider: estimate"]);
});

