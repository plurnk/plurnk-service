import assert from "node:assert/strict";
import test from "node:test";
import { UNKNOWN_POSITION, type EditStatement, type FindStatement, type DispositionStatement, type PlurnkStatement } from "@plurnk/plurnk-contracts";
import TurnOps from "./TurnOps.ts";
import { PlurnkParser } from "@plurnk/plurnk-parser";

test("{§turn-source-resources} the frozen projection keeps every statement and body whole, and adds no nested operations", () => {
    const lines = [
        'plurnk.read({"path":"workspace:///notes.md","range":"1,-1","pattern":<<<EOF\n/needle/\nEOF}) // inspect',
        'plurnk.edit({"path":"workspace:///notes.md","range":"@abcde","text":<<<EOF\nA literal example:\n```KILL (workspace:///not-an-operation)\n```\nReplacement text.\nEOF}) // replace',
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
    const parsed = PlurnkParser.parse(source, { executors: ["sh", "gitea"] });
    const statements = parsed.items.filter((item): item is { kind: "statement"; statement: PlurnkStatement } => item.kind === "statement")
        .map(({ statement }) => statement);
    assert.equal(statements.length, lines.length, "nested literal fences do not add operations");
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
    const expected = `plurnk.edit({"path":"workspace:///notes.md","text":<<<EOF\n${content}\nEOF})`;
    const statements = TurnOps.parseInternal(expected);
    assert.equal(TurnOps.renderEmission(statements), expected);
});

test("{§outside-text} prose lines outside Code Mode statements are retained as outside text", () => {
    const emitted = [
        'plurnk.edit({"path":"workspace:///notes.md","content":"complete body"})',
        "Interstitial commentary.",
        'plurnk.done({"text":"The answer."})',
        "Trailing commentary.",
    ].join("\n\n");
    const parsed = PlurnkParser.parse(emitted);
    const statements = parsed.items.filter((item) => item.kind === "statement").map((item) => (item as { statement: PlurnkStatement }).statement);
    assert.deepEqual(statements.map(({ op }) => op), ["edit", "done"]);
    assert.equal((statements[0] as EditStatement).body, "complete body");
    assert.equal(statements[1]?.op === "done" ? statements[1].body?.raw : null, "The answer.");
    assert.deepEqual(parsed.items.filter((item) => item.kind === "text").map((item) => (item as { content: string }).content.trim()),
        ["Interstitial commentary.", "Trailing commentary."]);
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

test("{§turn-source-resources} {§fence-pairing} TurnOps.parseInternal re-parses serialized <<<EOF1 bodies containing unclosed XML/heredoc fragments on the statements tier", () => {
    const innerFragment = [
        "Observed hostile model emission:",
        '<parameter name="text"><<<EOF',
        "line inside unclosed inner heredoc",
        "EOF",
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
    assert.match(serialized, /<<<EOF1\n/u);
    const reparsed = TurnOps.parseInternal(serialized);
    assert.equal(reparsed.length, 1);
    assert.equal(reparsed[0]?.op, "note");
    if (reparsed[0]?.op === "note") {
        assert.equal(reparsed[0].body, innerFragment);
    }

    // Statements-tier enforcement: model-only XML wrappers or omitted `)` must not sneak through TurnOps.parseInternal.
    assert.throws(
        () => TurnOps.parseInternal('await plurnk.done({"text":"unterminated"}'),
        /unterminated|syntax|error/iu,
    );
});
