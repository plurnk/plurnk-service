import assert from "node:assert/strict";
import test from "node:test";
import { UNKNOWN_POSITION, type EditStatement, type FindStatement, type PlanStatement, type SendStatement } from "@plurnk/plurnk-contracts";
import TurnOps from "./TurnOps.ts";

test("TurnOps: internal source round-trips through the public parser", () => {
    const statements: [PlanStatement, FindStatement, SendStatement] = [
        {
            op: "PLAN", delimiter: "", annotation: null, signal: null, target: null,
            lineMarker: null,
            body: [{
                content: "Orient from durable resources.",
                priority: "medium",
                status: "in_progress",
            }],
            position: UNKNOWN_POSITION,
        },
        {
            op: "FIND", delimiter: "", annotation: "workspace files",
            signal: ["+_plurnk", "+init"], target: { kind: "local", raw: "*" },
            lineMarker: { marks: [1, -1] }, body: null, position: UNKNOWN_POSITION,
        },
        {
            op: "SEND", delimiter: "", annotation: null, signal: 102, target: null,
            lineMarker: null, body: { raw: "Next: Address the prompt.", json: null }, position: UNKNOWN_POSITION,
        },
    ];
    const source = TurnOps.renderInternal(statements);
    assert.equal(source, [
        "# PLAN0",
        '[{"content":"Orient from durable resources.","priority":"medium","status":"in_progress"}]',
        "## FIND0 [+_plurnk,+init] (*) <1,-1> <!-- workspace files -->",
        "## SEND0 [102]",
        "Next: Address the prompt.",
    ].join("\n"));
    assert.deepEqual(TurnOps.parseInternal(source).map(({ op }) => op), ["PLAN", "FIND", "SEND"]);
});

test("TurnOps: internal source preserves trailing body newlines across a section boundary", () => {
    const edit: EditStatement = {
        op: "EDIT", delimiter: "", annotation: null, signal: null,
        target: { kind: "local", raw: "AGENTS.md" }, lineMarker: null,
        body: "# Policy\nBe exact.\n", position: UNKNOWN_POSITION,
    };
    const statements: [PlanStatement, EditStatement, SendStatement] = [
        {
            op: "PLAN", delimiter: "", annotation: null, signal: null, target: null,
            lineMarker: null, body: [], position: UNKNOWN_POSITION,
        },
        edit,
        {
            op: "SEND", delimiter: "", annotation: null, signal: 200, target: null,
            lineMarker: null, body: { raw: "done", json: null }, position: UNKNOWN_POSITION,
        },
    ];
    const parsed = TurnOps.parseInternal(TurnOps.renderInternal(statements));
    assert.equal(parsed[1]?.op, "EDIT");
    assert.equal((parsed[1] as EditStatement).body, edit.body);
});
