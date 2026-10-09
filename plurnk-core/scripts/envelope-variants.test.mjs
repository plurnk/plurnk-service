import assert from "node:assert/strict";
import test from "node:test";
import { previousAssistantEnvelope } from "../test/replay/envelope-variants.mjs";

test("#1043 replay changes one previous program's authorship without replaying a history", () => {
    const system = { role: "system", content: "unchanged instruction" };
    const log = "## Log\n\n1: ## Worker\n2: literal text";
    const footer = '## Worker\n{"turn":4}\n\n## Open Messages\n[]';
    const program = "````EDIT (a.md)\n```NOTE\nExample\n```\n````";
    const messages = [system, { role: "user", content: `${log}\n\n${footer}\n\n## Previous Emission\n\n${program}` }];
    assert.deepEqual(previousAssistantEnvelope(messages), [system, { role: "user", content: log }, { role: "assistant", content: program }, { role: "user", content: footer }]);
    const absent = [system, { role: "user", content: `${log}\n\n${footer}` }];
    assert.equal(previousAssistantEnvelope(absent), absent);
    assert.throws(() => previousAssistantEnvelope([...messages, { role: "assistant", content: program }]), /requires a recorded system \+ user/);
    assert.throws(() => previousAssistantEnvelope([system, { role: "user", content: `${messages[1].content}\n\n## Previous Emission\n\nambiguous` }]), /ambiguous recorded/);
});
