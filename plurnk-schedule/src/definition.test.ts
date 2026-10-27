import assert from "node:assert/strict";
import test from "node:test";
import { DefinitionError, readDefinition, targetSessionName } from "./definition.ts";

const definition = (target: string) => ({ rule: "FREQ=HOURLY;COUNT=1", target, prompt: "Check in." });

test("{§schedule-family} scheduled targets retain shared session identifiers exactly", () => {
    for (const name of ["a", "A", "0", "approach_a", "Approach_A", "trail-", "trail_", "01abcdef", "0f25c39a-a85d-46c8-b073-7f61a477e807", "A".repeat(63)]) {
        const target = `session://${name}`;
        assert.deepEqual(readDefinition(definition(target)), definition(target));
        assert.equal(targetSessionName(target), name);
    }
});

test("{§schedule-family} scheduled targets reject invalid identities and non-actor paths", () => {
    for (const target of [
        "session://", "session://_plurnk", "session://-a", `session://${"a".repeat(64)}`,
        "session://dot.name", "session://a b", "session://a\n", "session://a%62", "session://é",
        "session://alice/file.md", "session://alice?message=12345678", "session://alice#results",
        "session://user@alice", "session://alice:123", "https://alice",
    ]) {
        assert.throws(() => readDefinition(definition(target)), DefinitionError, target);
        assert.throws(() => targetSessionName(target), { name: "TypeError", message: `'${target}' is not a session:// target.` });
    }
});
