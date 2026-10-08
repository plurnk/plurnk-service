import assert from "node:assert/strict";
import test from "node:test";
import { UNKNOWN_POSITION, type EditStatement, type FindStatement, type DispositionStatement } from "@plurnk/plurnk-contracts";
import TurnOps from "./TurnOps.ts";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import type { PlurnkStatement } from "@plurnk/plurnk-contracts";


test("{§emission-row} the frozen projection keeps every header and body whole, and adds no nested operations", () => {
    const headers = [
        "READ (worker:///notes.md) <1,-1> /needle/ <!-- inspect -->",
        "EDIT (worker:///notes.md) <@abcde> <!-- replace -->",
        "COPY (worker:///a.md) <2,4> (worker:///b.md) <0>",
        "MOVE (worker:///b.md) <1,2> (worker:///c.md) <-1>",
        "sh [{\"env\":{\"LANG\":\"C\"}}] <!-- verify -->",
        "gitea (list_issues)",
        "WORK (worker://helper)",
        "SEND (worker://helper)",
        "NOTE",
        "KILL",
    ];
    const bodies = [
        null,
        "A literal example:\n```KILL (worker:///not-an-operation)\n```\nReplacement text.",
        null,
        null,
        "printf '%s\\n' verification",
        '{"repository":"example"}',
        "Investigate the project.",
        "Coordinate the investigation.",
        "Remember the conclusion.",
        "The complete final answer.",
    ];
    const source = headers.map((header, index) => PlurnkParser.frame(header, bodies[index]!)).join("\n\n");
    const parsed = PlurnkParser.parse(source, { executors: ["sh", "gitea"] });
    const statements = parsed.items.filter((item): item is { kind: "statement"; statement: PlurnkStatement } => item.kind === "statement")
        .map(({ statement }) => statement);
    assert.equal(statements.length, headers.length, "nested literal fences do not add operations");
    const original = structuredClone(statements);
    assert.equal(TurnOps.renderEmission(statements), headers.map((header, index) => PlurnkParser.frame(header, bodies[index]!)).join("\n\n"),
        "every statement is its own original operation, whole");
    assert.deepEqual(statements, original, "projection never changes the statements that execute");
});

for (const [name, body] of [
    ["absent", null],
    ["empty", ""],
    ["nonempty", "The original body."],
] as const) {
    for (const header of ["EDIT (worker:///notes.md)", "SEND (worker://helper)"]) {
        test(`{§emission-row} ${header}: an ${name} body renders as the worker wrote it`, () => {
            const source = PlurnkParser.frame(header, body);
            const statements = TurnOps.parseInternal(source);
            assert.equal(statements.length, 1);
            assert.equal(TurnOps.renderEmission(statements), PlurnkParser.frame(header, body === "" ? null : body));
        });
    }
}

test("{§emission-row} a long body is frozen whole", () => {
    const body = Array.from({ length: 120 }, (_line, index) => `line ${index + 1}`).join("\n");
    const statements = TurnOps.parseInternal(PlurnkParser.frame("EDIT (worker:///notes.md)", body));
    assert.equal(TurnOps.renderEmission(statements), PlurnkParser.frame("EDIT (worker:///notes.md)", body));
});

test("{§outside-text} {§terminal-kill} comments before KILL remain outside; comments after it belong to the answer", () => {
    const emitted = [
        `${PlurnkParser.frame("EDIT (worker:///notes.md)", "complete body")} <!-- imitated aside -->`,
        PlurnkParser.frame("KILL", "The answer."),
        "<!-- a trailing comment of its own -->",
    ].join("\n\n");
    const parsed = PlurnkParser.parse(emitted);
    const statements = parsed.items.filter((item) => item.kind === "statement").map((item) => (item as { statement: PlurnkStatement }).statement);
    assert.deepEqual(statements.map(({ op }) => op), ["EDIT", "KILL"]);
    assert.equal((statements[0] as EditStatement).body, "complete body");
    assert.equal(statements[1]?.op === "KILL" ? statements[1].body : null, "The answer.\n```\n\n<!-- a trailing comment of its own -->");
    assert.deepEqual(parsed.items.filter((item) => item.kind === "text").map((item) => (item as { content: string }).content.trim()),
        ["<!-- imitated aside -->"]);
});

test("{§op-execution-order} internal programs may omit a disposition without inventing one", () => {
    const source = "```READ (worker:///notes.md)```";
    const parsed = TurnOps.parseInternal(source);
    assert.deepEqual(parsed.map(({ op }) => op), ["READ"]);
    assert.equal(TurnOps.renderInternal(parsed), "```READ (worker:///notes.md)\n```");
});

test("TurnOps: internal source round-trips through the public parser", () => {
    const statements: [FindStatement, DispositionStatement] = [
        {
            op: "FIND", aside: "workspace files",
            target: { kind: "local", raw: "*" },
            metadata: ['{"trace": "one", "shape": {"nested": true}}'], lineMarker: { marks: [1, -1] }, matcher: null, body: null, position: UNKNOWN_POSITION,
        },
        {
            op: "WAIT", aside: null, target: null, metadata: null,
            lineMarker: null, body: "Observe the results.", position: UNKNOWN_POSITION,
        },
    ];
    const source = TurnOps.renderInternal(statements);
    assert.equal(source, [
        "```FIND (*) <1,-1> [{\"trace\": \"one\", \"shape\": {\"nested\": true}}] <!-- workspace files -->",
        "```",
        "",
        "```WAIT",
        "Observe the results.",
        "```",
    ].join("\n"));
    const parsed = TurnOps.parseInternal(source);
    assert.deepEqual(parsed.map(({ op }) => op), ["FIND", "WAIT"]);
    assert.deepEqual(parsed[0]?.op === "FIND" ? parsed[0].metadata : undefined, ['{"trace": "one", "shape": {"nested": true}}']);
    assert.equal(parsed[1]?.op === "WAIT" ? parsed[1].body : null, statements[1].body);
});

test("TurnOps: internal source preserves trailing body newlines across a section boundary", () => {
    const edit: EditStatement = {
        op: "EDIT", aside: null,
        target: { kind: "local", raw: "AGENTS.md" }, metadata: null, lineMarker: null,
        matcher: null, body: "# Policy\nBe exact.\n", position: UNKNOWN_POSITION,
    };
    const statements: [EditStatement, DispositionStatement] = [
        edit,
        {
            op: "WAIT", aside: null, target: null, metadata: null,
            lineMarker: null, body: "Edit applied.", position: UNKNOWN_POSITION,
        },
    ];
    const parsed = TurnOps.parseInternal(TurnOps.renderInternal(statements));
    assert.equal(parsed[0]?.op, "EDIT");
    assert.equal((parsed[0] as EditStatement).body, edit.body);
});
