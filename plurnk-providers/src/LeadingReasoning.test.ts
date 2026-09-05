import assert from "node:assert/strict";
import test from "node:test";
import LeadingReasoning from "./LeadingReasoning.ts";

test("{§provider-tagged-reasoning}: every delimiter split preserves exact reasoning and the suffix", () => {
    for (const envelopes of [LeadingReasoning.THINK, LeadingReasoning.TEMPLATE]) {
        for (const [opening, closing] of envelopes) {
            const thought = "Decision 🧠\nA < B.\n";
            const suffix = "Answer with literal <think>tags</think>.";
            for (const ended of [true, false]) {
                const input = `${opening}${thought}${ended ? closing + suffix : closing.slice(0, 3)}`;
                const expected = thought + (ended ? "" : closing.slice(0, 3));
                for (let split = 0; split <= input.length; split++) {
                    const parser = new LeadingReasoning(envelopes);
                    const observed = parser.push(input.slice(0, split)) + parser.push(input.slice(split)) + parser.finish();
                    assert.equal(observed, expected, `${opening}: split ${split}`);
                }
                const settled = LeadingReasoning.project(input, "", envelopes);
                assert.equal(settled.reasoning, expected);
                assert.equal(settled.content, ended ? suffix : "");
                assert.equal(settled.contentStart, [...input].length - [...settled.content].length);
            }
        }
    }
});

test("{§provider-tagged-reasoning}: an incomplete opener, later tags, and structured reasoning stay literal", () => {
    for (const input of ["<thi", " <think>text</think>", "prefix <think>text</think>", ""]) {
        assert.deepEqual(LeadingReasoning.project(input, "", LeadingReasoning.THINK), { content: input, reasoning: "", projected: false, contentStart: 0 });
    }
    assert.deepEqual(LeadingReasoning.project("<think>literal</think>", "native", LeadingReasoning.THINK), {
        content: "<think>literal</think>", reasoning: "native", projected: false, contentStart: 0,
    });
});
