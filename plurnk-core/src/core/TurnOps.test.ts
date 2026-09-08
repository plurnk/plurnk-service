import assert from "node:assert/strict";
import test from "node:test";
import { UNKNOWN_POSITION, type EditStatement, type FindStatement, type PlanStatement, type DispositionStatement } from "@plurnk/plurnk-contracts";
import TurnOps from "./TurnOps.ts";

test("TurnOps: internal source round-trips through the public parser", () => {
    const statements: [PlanStatement, FindStatement, DispositionStatement] = [
        {
            op: "PLAN", annotation: null, target: null, metadata: null,
            lineMarker: null,
            body: [{
                content: "Orient from durable resources.",
                status: "in_progress",
            }],
            position: UNKNOWN_POSITION,
        },
        {
            op: "FIND", annotation: "workspace files",
 target: { kind: "local", raw: "*" },
            metadata: ["trace: one", "shape: {nested}"], lineMarker: { marks: [1, -1] }, body: null, position: UNKNOWN_POSITION,
        },
        {
            op: "NEXT", annotation: null, target: null, metadata: null,
            lineMarker: null, body: { raw: "Next: Address the prompt.", json: null }, position: UNKNOWN_POSITION,
        },
    ];
    const source = TurnOps.renderInternal(statements);
    assert.equal(source, [
        "```PLAN",
        "[{\"content\":\"Orient from durable resources.\",\"status\":\"in_progress\"}]",
        "```",
        "```FIND (*) {trace: one} {shape: {nested}} <1,-1> <!-- workspace files -->```",
        "```NEXT",
        "Next: Address the prompt.",
        "```",
    ].join("\n"));
    const parsed = TurnOps.parseInternal(source);
    assert.deepEqual(parsed.map(({ op }) => op), ["PLAN", "FIND", "NEXT"]);
    assert.deepEqual(parsed[1]?.op === "FIND" ? parsed[1].metadata : undefined, ["trace: one", "shape: {nested}"]);
});

test("TurnOps: internal source preserves trailing body newlines across a section boundary", () => {
    const edit: EditStatement = {
        op: "EDIT", annotation: null,
        target: { kind: "local", raw: "AGENTS.md" }, metadata: null, lineMarker: null,
        body: "# Policy\nBe exact.\n", position: UNKNOWN_POSITION,
    };
    const statements: [PlanStatement, EditStatement, DispositionStatement] = [
        {
            op: "PLAN", annotation: null, target: null, metadata: null,
            lineMarker: null, body: [], position: UNKNOWN_POSITION,
        },
        edit,
        {
            op: "DONE", annotation: null, target: null, metadata: null,
            lineMarker: null, body: { raw: "done", json: null }, position: UNKNOWN_POSITION,
        },
    ];
    const parsed = TurnOps.parseInternal(TurnOps.renderInternal(statements));
    assert.equal(parsed[1]?.op, "EDIT");
    assert.equal((parsed[1] as EditStatement).body, edit.body);
});
