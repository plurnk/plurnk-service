import assert from "node:assert/strict";
import test from "node:test";
import { DefinitionError, readDefinition, targetWorkerName } from "./definition.ts";

const definition = (target: string) => ({ rule: "FREQ=HOURLY;COUNT=1", target, prompt: "Check in." });

test("{§schedule-family} scheduled targets retain shared worker identifiers exactly", () => {
    for (const name of ["a", "A", "0", "approach_a", "Approach_A", "trail-", "trail_", "01abcdef", "0f25c39a-a85d-46c8-b073-7f61a477e807", "A".repeat(63)]) {
        const target = `worker://${name}`;
        assert.deepEqual(readDefinition(definition(target)), definition(target));
        assert.equal(targetWorkerName(target), name);
    }
});

test("{§schedule-family} scheduled targets reject invalid identities and non-actor paths", () => {
    for (const target of [
        "worker://", "worker://_plurnk", "worker://-a", `worker://${"a".repeat(64)}`,
        "worker://dot.name", "worker://a b", "worker://a\n", "worker://a%62", "worker://é",
        "worker://alice/file.md", "worker://alice?message=12345678", "worker://alice#results",
        "worker://user@alice", "worker://alice:123", "https://alice",
    ]) {
        assert.throws(() => readDefinition(definition(target)), DefinitionError, target);
        assert.throws(() => targetWorkerName(target), { name: "TypeError", message: `'${target}' is not a worker:// target.` });
    }
});
