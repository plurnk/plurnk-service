import assert from "node:assert/strict";
import test from "node:test";
import { DefinitionError, isScriptDefinition, readDefinition, targetSessionName } from "./definition.ts";

const definition = (target: string) => ({ rule: "FREQ=HOURLY;COUNT=1", target, prompt: "Check in." });

test("{§schedule-family} scheduled targets retain shared session identifiers and support dual prompt/run and null-rule obligations", () => {
    for (const name of ["a", "A", "0", "approach_a", "Approach_A", "trail-", "trail_", "01abcdef", "0f25c39a-a85d-46c8-b073-7f61a477e807", "A".repeat(63)]) {
        const target = `session://${name}`;
        assert.deepEqual(readDefinition(definition(target)), definition(target));
        assert.equal(targetSessionName(target), name);
    }
    const unscheduledPrompt = readDefinition({
        rule: null,
        target: "session://worker",
        prompt: "Audit module.",
        persona: "reviewer",
    });
    assert.equal(isScriptDefinition(unscheduledPrompt), false);
    assert.equal(unscheduledPrompt.rule, null);

    const scripted = readDefinition({
        rule: "0 * * * *",
        run: "await plurnk.sh({\"command\":\"echo ok\"});",
        catchup: false,
    });
    assert.equal(isScriptDefinition(scripted), true);
});

test("{§schedule-family} scheduled definitions reject invalid identities, mixed prompt+run payloads, and non-actor paths", () => {
    for (const target of [
        "session://", "session://_plurnk", "session://-a", `session://${"a".repeat(64)}`,
        "session://dot.name", "session://a b", "session://a\n", "session://a%62", "session://é",
        "session://alice/file.md", "session://alice?message=12345678", "session://alice#results",
        "session://user@alice", "session://alice:123", "https://alice",
    ]) {
        assert.throws(() => readDefinition(definition(target)), DefinitionError, target);
        assert.throws(() => targetSessionName(target), { name: "TypeError", message: `'${target}' is not a session:// target.` });
    }
    assert.throws(
        () => readDefinition({ rule: null, target: "session://bot", prompt: "hi", run: "await plurnk.done();" }),
        DefinitionError,
    );
});
