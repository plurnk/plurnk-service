import assert from "node:assert/strict";
import test from "node:test";
import { DefinitionError, isScriptDefinition, isUntimedRule, readDefinition, targetSessionName } from "./definition.ts";

const definition = (target: string) => ({ rule: "FREQ=HOURLY;COUNT=1", target, prompt: "Check in." });

test("{§schedule-family} {§schedule-rule} scheduled targets retain shared session identifiers and support manual/once rules and structured run arrays", () => {
    for (const name of ["a", "A", "0", "approach_a", "Approach_A", "trail-", "trail_", "01abcdef", "0f25c39a-a85d-46c8-b073-7f61a477e807", "A".repeat(63)]) {
        const target = `session://${name}`;
        assert.deepEqual(readDefinition(definition(target)), definition(target));
        assert.equal(targetSessionName(target), name);
    }
    const defaultedManualPrompt = readDefinition({
        target: "session://worker",
        prompt: "Audit module.",
        persona: "reviewer",
    });
    assert.equal(isScriptDefinition(defaultedManualPrompt), false);
    assert.equal(defaultedManualPrompt.rule, "manual");
    assert.equal(isUntimedRule(defaultedManualPrompt.rule), true);

    const oncePrompt = readDefinition({
        rule: "once",
        target: "session://worker",
        prompt: "Run once.",
    });
    assert.equal(oncePrompt.rule, "once");
    assert.equal(isUntimedRule(oncePrompt.rule), true);

    const scripted = readDefinition({
        run: [
            { server: "plurnk", tool: "sh", arguments: { command: "echo ok" }, aside: "echo" },
        ],
        catchup: false,
    });
    assert.equal(isScriptDefinition(scripted), true);
    if (!isScriptDefinition(scripted)) throw new Error("expected script definition");
    assert.equal(scripted.rule, "manual");
    assert.equal(scripted.run.length, 1);
    assert.equal(scripted.run[0].server, "plurnk");
    assert.equal(scripted.run[0].tool, "sh");
});

test("{§schedule-family} {§schedule-rule} scheduled definitions reject invalid identities, null rule, string or empty run, mixed prompt+run, and non-actor paths", () => {
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
        () => readDefinition({ rule: null, target: "session://bot", prompt: "hi" }),
        DefinitionError,
        "retired rule: null is rejected",
    );
    assert.throws(
        () => readDefinition({ rule: "manual", run: "await plurnk.note({\"text\":\"hi\"});" }),
        DefinitionError,
        "retired string run is rejected",
    );
    assert.throws(
        () => readDefinition({ rule: "manual", run: [] }),
        DefinitionError,
        "empty run array is rejected",
    );
    assert.throws(
        () => readDefinition({
            rule: "once",
            target: "session://bot",
            prompt: "hi",
            run: [{ server: "plurnk", tool: "note", arguments: { text: "hi" } }],
        }),
        DefinitionError,
        "mixed prompt and run is rejected",
    );
});
