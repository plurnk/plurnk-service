import assert from "node:assert/strict";
import test from "node:test";
import { UNKNOWN_POSITION, type EditStatement, type FindStatement, type DispositionStatement, type PlurnkStatement } from "@plurnk/plurnk-contracts";
import TurnOps from "./TurnOps.ts";
import { PlurnkParser } from "@plurnk/plurnk-parser";


test("{§emission-row} the frozen projection keeps every header and body whole, and adds no nested operations", () => {
    const headers = [
        "READ (workspace:///notes.md) <1,-1> /needle/ <!-- inspect -->",
        "EDIT (workspace:///notes.md) <@abcde> <!-- replace -->",
        "COPY (workspace:///a.md) <2,4> (workspace:///b.md) <0>",
        "MOVE (workspace:///b.md) <1,2> (workspace:///c.md) <-1>",
        "sh [{\"env\":{\"LANG\":\"C\"}}] <!-- verify -->",
        "gitea (list_issues)",
        "WORK (session://helper)",
        "SEND (session://helper)",
        "NOTE",
        "SEND [200]",
    ];
    const bodies = [
        null,
        "A literal example:\n```KILL (workspace:///not-an-operation)\n```\nReplacement text.",
        null,
        null,
        "printf '%s\\n' verification",
        '{"repository":"example"}',
        "Investigate the project.",
        "Coordinate the investigation.",
        "Remember the conclusion.",
        "The complete final answer.",
    ];
    const source = headers.map((header, index) => PlurnkParser.frame(header, bodies[index])).join("\n\n");
    const parsed = PlurnkParser.parse(source, { executors: ["sh", "gitea"] });
    const statements = parsed.items.filter((item): item is { kind: "statement"; statement: PlurnkStatement } => item.kind === "statement")
        .map(({ statement }) => statement);
    assert.equal(statements.length, headers.length, "nested literal fences do not add operations");
    const original = structuredClone(statements);
    assert.equal(TurnOps.renderEmission(statements), headers.map((header, index) => PlurnkParser.frame(header, bodies[index])).join("\n\n"),
        "every statement is its own original operation, whole");
    assert.deepEqual(statements, original, "projection never changes the statements that execute");
});

for (const [name, body] of [
    ["absent", null],
    ["empty", ""],
    ["nonempty", "The original body."],
] as const) {
    for (const header of ["EDIT (workspace:///notes.md)", "SEND (session://helper)"]) {
        test(`{§emission-row} ${header}: an ${name} body renders as the session wrote it`, () => {
            const source = PlurnkParser.frame(header, body);
            const statements = TurnOps.parseInternal(source);
            assert.equal(statements.length, 1);
            assert.equal(TurnOps.renderEmission(statements), PlurnkParser.frame(header, body === "" ? null : body));
        });
    }
}

test("{§emission-row} a long body is frozen whole", () => {
    const body = Array.from({ length: 120 }, (_line, index) => `line ${index + 1}`).join("\n");
    const statements = TurnOps.parseInternal(PlurnkParser.frame("EDIT (workspace:///notes.md)", body));
    assert.equal(TurnOps.renderEmission(statements), PlurnkParser.frame("EDIT (workspace:///notes.md)", body));
});


test("{§outside-text} comments outside operation fences are not part of a reply", () => {
    const emitted = [
        `${PlurnkParser.frame("EDIT (workspace:///notes.md)", "complete body")} <!-- imitated aside -->`,
        PlurnkParser.frame("SEND [200]", "The answer."),
        "<!-- a trailing comment of its own -->",
    ].join("\n\n");
    const parsed = PlurnkParser.parse(emitted);
    const statements = parsed.items.filter((item) => item.kind === "statement").map((item) => (item as { statement: PlurnkStatement }).statement);
    assert.deepEqual(statements.map(({ op }) => op), ["EDIT", "SEND"]);
    assert.equal((statements[0] as EditStatement).body, "complete body");
    assert.equal(statements[1]?.op === "SEND" ? statements[1].body?.raw : null, "The answer.");
    assert.deepEqual(parsed.items.filter((item) => item.kind === "text").map((item) => (item as { content: string }).content.trim()),
        ["<!-- imitated aside -->", "<!-- a trailing comment of its own -->"]);
});

test("{§op-execution-order} internal programs may omit a disposition without inventing one", () => {
    const source = "```READ (workspace:///notes.md)```";
    const parsed = TurnOps.parseInternal(source);
    assert.deepEqual(parsed.map(({ op }) => op), ["READ"]);
    assert.equal(TurnOps.renderInternal(parsed), "```READ (workspace:///notes.md)\n```");
});

test("{§turn-record} TurnOps: internal source round-trips through the public parser", () => {
    const statements: [FindStatement, DispositionStatement] = [
        {
            op: "FIND", aside: "workspace files",
            target: { kind: "local", raw: "*" },
            metadata: ['{"trace": "one", "shape": {"nested": true}}'], lineMarker: { marks: [1, -1] }, matcher: null, body: null, position: UNKNOWN_POSITION,
        },
        {
            op: "WAIT", aside: null, target: null, metadata: null, seconds: null,
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

test("{§turn-record} TurnOps: internal source preserves trailing body newlines across a section boundary", () => {
    const edit: EditStatement = {
        op: "EDIT", aside: null,
        target: { kind: "local", raw: "AGENTS.md" }, metadata: null, lineMarker: null,
        matcher: null, body: "# Policy\nBe exact.\n", position: UNKNOWN_POSITION,
    };
    const statements: [EditStatement, DispositionStatement] = [
        edit,
        {
            op: "WAIT", aside: null, target: null, metadata: null, seconds: null,
            lineMarker: null, body: "Edit applied.", position: UNKNOWN_POSITION,
        },
    ];
    const parsed = TurnOps.parseInternal(TurnOps.renderInternal(statements));
    assert.equal(parsed[0]?.op, "EDIT");
    assert.equal((parsed[0]).body, edit.body);
});
