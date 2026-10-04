import assert from "node:assert/strict";
import test from "node:test";
import ReasoningView from "./ReasoningView.ts";
import { PlurnkParser } from "@plurnk/plurnk-parser";

test("{§reasoning-initial-read}: initialization reads its own source without a scope — whole when it fits ({§context-fit})", () => {
    const read = ReasoningView.initialRead("alice", 3, 8);
    assert.equal(read.target?.raw, "reasoning://alice/3/8");
    assert.equal(read.aside, "inspect this turn's reasoning");
    assert.equal(read.matcher, null);
    assert.equal(read.lineMarker, null, "no knob pages the rationale; the budget decides whether it lands whole");
});

test("{§reasoning-operations}: the authored rationale retains the complete reasoning program", () => {
    const program = [
        PlurnkParser.frame("NOTE", "Survey the environment."),
        PlurnkParser.frame("FIND (worker:///*)", null),
        PlurnkParser.frame("READ (reasoning://alice/1/1)", null),
    ].join("\n\n");
    const source = ReasoningView.initialSource(program);
    assert.ok(source.endsWith(program), "the authored program is not rewritten or supplemented");
    const operations = PlurnkParser.parseReasoningOperations(source);
    assert.deepEqual(operations.map(({ op }) => op), ["NOTE", "FIND", "READ"]);
    assert.equal(operations[0]!.body, "Survey the environment.");
});
