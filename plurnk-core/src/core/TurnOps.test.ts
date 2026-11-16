import assert from "node:assert/strict";
import test from "node:test";
import { UNKNOWN_POSITION, type EditStatement, type FindStatement, type DispositionStatement, type PlurnkStatement } from "@plurnk/plurnk-contracts";
import TurnOps from "./TurnOps.ts";
import EmissionSplit from "./EmissionSplit.ts";
import { PlurnkParser } from "@plurnk/plurnk-parser";

test("{§turn-source-resources} the frozen projection keeps every statement and body whole, and adds no nested operations", () => {
    const lines = [
        'plurnk.read({"path":"workspace:///notes.md","range":"1,-1","pattern":"/needle/"}) // inspect',
        `plurnk.edit(${JSON.stringify({ path: "workspace:///notes.md", range: "@abcde", text: "A literal example:\n```KILL (workspace:///not-an-operation)\n```\nReplacement text." })}) // replace`,
        'plurnk.copy({"from":{"path":"workspace:///a.md","range":"2,4"},"to":{"path":"workspace:///b.md","range":"0"}})',
        'plurnk.move({"from":{"path":"workspace:///b.md","range":"1,2"},"to":{"path":"workspace:///c.md","range":"-1"}})',
        'plurnk.sh({"cwd":"src","text":"printf \'%s\\\\n\' verification"}) // verify',
        'gitea.list_issues({"repository":"example"})',
        'plurnk.work({"target":"session://helper","text":"Investigate the project."})',
        'plurnk.send({"target":"session://helper","text":"Coordinate the investigation."})',
        'plurnk.note({"text":"Remember the conclusion."})',
        'plurnk.done({"text":"The complete final answer."})',
        'plurnk.fail({"text":"The failure explanation."})',
    ];
    const source = lines.join("\n\n");
    const parsed = PlurnkParser.parseStatements(source, { executors: ["sh", "gitea"] });
    const statements = parsed.items.filter((item): item is { kind: "statement"; statement: PlurnkStatement } => item.kind === "statement")
        .map(({ statement }) => statement);
    assert.equal(statements.length, lines.length, "nested literal examples do not add operations");
    const original = structuredClone(statements);
    assert.equal(TurnOps.renderEmission(statements), source, "every statement is its own original operation, whole");
    assert.deepEqual(statements, original, "projection never changes the statements that execute");
});

for (const [name, content] of [
    ["absent", undefined],
    ["empty", ""],
    ["nonempty", "The original body."],
] as const) {
    test(`{§turn-source-resources} EDIT: an ${name} body renders as the session wrote it`, () => {
        const expected = content === undefined || content === ""
            ? 'plurnk.edit({"path":"workspace:///notes.md"})'
            : `plurnk.edit(${JSON.stringify({ path: "workspace:///notes.md", text: content })})`;
        const statements = TurnOps.parseInternal(expected);
        assert.equal(statements.length, 1);
        assert.equal(TurnOps.renderEmission(statements), expected);
    });
    test(`{§turn-source-resources} SEND: an ${name} body renders as the session wrote it`, () => {
        const expected = content === undefined || content === ""
            ? 'plurnk.send({"target":"session://helper"})'
            : `plurnk.send(${JSON.stringify({ target: "session://helper", text: content })})`;
        const statements = TurnOps.parseInternal(expected);
        assert.equal(statements.length, 1);
        assert.equal(TurnOps.renderEmission(statements), expected);
    });
}

test("{§turn-source-resources} a long body is frozen whole", () => {
    const content = Array.from({ length: 120 }, (_line, index) => `line ${index + 1}`).join("\n");
    const expected = `plurnk.edit(${JSON.stringify({ path: "workspace:///notes.md", text: content })})`;
    const statements = TurnOps.parseInternal(expected);
    assert.equal(TurnOps.renderEmission(statements), expected);
});

test("{§outside-text} non-empty assistant prose lowers to a leading plurnk.note before structured mcp tool calls", () => {
    const split = EmissionSplit.splitResponse({
        assistant: {
            content: "Bearings: inspected the workspace.",
            reasoning: null,
            finishReason: "tool_calls",
            model: "test-model",
            toolCalls: [
                { index: 0, id: "c1", type: "function" as const, name: "mcp", arguments: JSON.stringify({ server: "plurnk", tool: "edit", arguments: { path: "workspace:///notes.md", text: "complete body" } }) },
                { index: 1, id: "c2", type: "function" as const, name: "mcp", arguments: JSON.stringify({ server: "plurnk", tool: "done", arguments: { text: "The answer." } }) },
            ],
        },
        assistantRaw: {},
        accounting: [],
        capacity: {
            decision: "defer",
            contextWindow: null,
            maxInputTokens: null,
            maxOutputTokens: null,
            outputBudget: null,
            outputFloor: null,
            reasoningBudget: null,
            inputCapacity: null,
            inputWall: null,
            responseMax: null,
            prompt: { kind: "unavailable", source: "test", detail: "test" },
        },
    });
    assert.equal(split.emissionValid, true);
    assert.deepEqual(split.packetAssistant.ops.map((s) => "op" in s ? s.op : s.runtime), ["note", "edit", "done"]);
    assert.equal(split.packetAssistant.ops[0]?.op === "note" ? split.packetAssistant.ops[0].body : null, "Bearings: inspected the workspace.");
    assert.equal((split.packetAssistant.ops[1] as EditStatement).body, "complete body");
    assert.equal(split.packetAssistant.ops[2]?.op === "done" ? split.packetAssistant.ops[2].body?.raw : null, "The answer.");
});

test("{§op-methods-op-dispatch} internal programs may omit a disposition without inventing one", () => {
    const source = 'plurnk.read({"path":"workspace:///notes.md"})';
    const parsed = TurnOps.parseInternal(source);
    assert.deepEqual(parsed.map(({ op }) => op), ["read"]);
    assert.equal(TurnOps.renderInternal(parsed), source);
});

test("{§turn-record} TurnOps: internal source round-trips through the public parser", () => {
    const statements: [FindStatement, DispositionStatement] = [
        {
            op: "find", aside: "workspace files",
            target: { kind: "local", raw: "*" },
            headers: { "X-Trace": "one" }, lineMarker: { marks: [1, -1] }, matcher: null, body: null, position: UNKNOWN_POSITION,
        },
        {
            op: "wait", aside: null, target: null, seconds: null,
            lineMarker: null, body: "Observe the results.", position: UNKNOWN_POSITION,
        },
    ];
    const source = TurnOps.renderInternal(statements);
    assert.equal(source, [
        'plurnk.find({"path":"*","range":"1,-1","headers":{"X-Trace":"one"}}) // workspace files',
        "",
        'plurnk.wait({}) // Observe the results.',
    ].join("\n"));
    const parsed = TurnOps.parseInternal(source);
    assert.deepEqual(parsed.map(({ op }) => op), ["find", "wait"]);
    assert.deepEqual(parsed[0]?.op === "find" ? parsed[0].headers : undefined, { "X-Trace": "one" });
    assert.equal(parsed[1]?.op === "wait" ? parsed[1].aside : null, statements[1].body);
});

test("{§turn-record} TurnOps: internal source preserves trailing body newlines across a section boundary", () => {
    const edit: EditStatement = {
        op: "edit", aside: null,
        target: { kind: "local", raw: "AGENTS.md" }, headers: null, lineMarker: null,
        matcher: null, body: "# Policy\nBe exact.\n", position: UNKNOWN_POSITION,
    };
    const statements: [EditStatement, DispositionStatement] = [
        edit,
        {
            op: "wait", aside: null, target: null, seconds: null,
            lineMarker: null, body: "Edit applied.", position: UNKNOWN_POSITION,
        },
    ];
    const parsed = TurnOps.parseInternal(TurnOps.renderInternal(statements));
    assert.equal(parsed[0]?.op, "edit");
    assert.equal((parsed[0]).body, edit.body);
});

test("{§turn-source-resources} {§expression-boundaries} TurnOps.parseInternal round-trips JSON-escaped multiline bodies containing arbitrary markup fragments", () => {
    const innerFragment = [
        "Observed multiline payload:",
        '<parameter name="text">',
        "line inside markup fragment",
    ].join("\n");
    const noteStmt: PlurnkStatement = {
        op: "note",
        aside: null,
        target: null,
        lineMarker: null,
        body: innerFragment,
        position: UNKNOWN_POSITION,
    };
    const serialized = TurnOps.renderEmission([noteStmt]);
    const reparsed = TurnOps.parseInternal(serialized);
    assert.equal(reparsed.length, 1);
    assert.equal(reparsed[0]?.op, "note");
    if (reparsed[0]?.op === "note") {
        assert.equal(reparsed[0].body, innerFragment);
    }

    assert.throws(
        () => TurnOps.parseInternal('plurnk.done({"text":"unterminated"}'),
        /unterminated|syntax|error|expected/iu,
    );
});
