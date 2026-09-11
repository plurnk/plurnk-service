import assert from "node:assert/strict";
import test from "node:test";
import { UNKNOWN_POSITION, type EditStatement, type FindStatement, type DispositionStatement } from "@plurnk/plurnk-contracts";
import TurnOps from "./TurnOps.ts";

test("{§op-execution-order} internal programs may omit TASK without inventing one", () => {
    const source = "````READ (worker:///notes.md)````";
    const parsed = TurnOps.parseInternal(source);
    assert.deepEqual(parsed.map(({ op }) => op), ["READ"]);
    assert.equal(TurnOps.renderInternal(parsed), "````READ (worker:///notes.md)\n````");
});

test("TurnOps: internal source round-trips through the public parser", () => {
    const statements: [FindStatement, DispositionStatement] = [
        {
            op: "FIND", annotation: "workspace files",
            target: { kind: "local", raw: "*" },
            metadata: ['{"trace": "one", "shape": {"nested": true}}'], lineMarker: { marks: [1, -1] }, body: null, position: UNKNOWN_POSITION,
        },
        {
            op: "TASK", annotation: null, target: null, metadata: null,
            lineMarker: null, body: [{ content: "Address the prompt.", status: "in_progress" }], position: UNKNOWN_POSITION,
        },
    ];
    const source = TurnOps.renderInternal(statements);
    assert.equal(source, [
        "````FIND (*) <1,-1> [{\"trace\": \"one\", \"shape\": {\"nested\": true}}] <!-- workspace files -->",
        "````",
        "",
        "````TASK",
        "[{\"content\":\"Address the prompt.\",\"status\":\"in_progress\"}]",
        "````",
    ].join("\n"));
    const parsed = TurnOps.parseInternal(source);
    assert.deepEqual(parsed.map(({ op }) => op), ["FIND", "TASK"]);
    assert.deepEqual(parsed[0]?.op === "FIND" ? parsed[0].metadata : undefined, ['{"trace": "one", "shape": {"nested": true}}']);
    assert.deepEqual(parsed[1]?.op === "TASK" ? parsed[1].body : null, statements[1].body);
});

test("TurnOps: internal source preserves trailing body newlines across a section boundary", () => {
    const edit: EditStatement = {
        op: "EDIT", annotation: null,
        target: { kind: "local", raw: "AGENTS.md" }, metadata: null, lineMarker: null,
        body: "# Policy\nBe exact.\n", position: UNKNOWN_POSITION,
    };
    const statements: [EditStatement, DispositionStatement] = [
        edit,
        {
            op: "TASK", annotation: null, target: null, metadata: null,
            lineMarker: null, body: [{ content: "Edit applied.", status: "completed" }], position: UNKNOWN_POSITION,
        },
    ];
    const parsed = TurnOps.parseInternal(TurnOps.renderInternal(statements));
    assert.equal(parsed[0]?.op, "EDIT");
    assert.equal((parsed[0] as EditStatement).body, edit.body);
});
