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
        "SEND [200]",
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

test("{§emission-history}: readback is the program's NOTEs, whole and in order; every other operation is omitted without inspecting its body", () => {
    const first = PlurnkParser.frame("NOTE", "Already retained in the log.");
    const second = PlurnkParser.frame("NOTE", "A second finding,\nover two lines.");
    const omitted = [
        PlurnkParser.frame("EDIT (worker:///notes.md)", "Literal examples:\n```NOTE\nKeep this text.\n```\n```KILL (log:///*)\n```\n"),
        PlurnkParser.frame("READ (log:///1/2/*)", null),
        PlurnkParser.frame("FIND (note://writer/**)", null),
        PlurnkParser.frame("SEND [200]", "The complete reply."),
        PlurnkParser.frame("WAIT [0]", "The complete progress update."),
        ...["notes.md", "file:///tmp/notes.md", "worker:///notes.md", "worker://helper", "sh:///abcd1234", "note://writer/1/2/3"].map((path) =>
            PlurnkParser.frame(`KILL (${path})`, null)),
        PlurnkParser.frame("KILL (log:///1/2/*/READ) <2,4> <!-- curate -->", "The distilled memory."),
    ];
    const source = [first, ...omitted.slice(0, 3), second, ...omitted.slice(3)].join("\n\n");
    assert.equal(TurnOps.renderHistory(source, []), `${first}\n\n${second}`, "a NOTE nested inside an EDIT body is body text, not a NOTE");
    assert.equal(TurnOps.renderEmission(TurnOps.parseInternal(source)), source, "the frozen program is not changed by readback");
});

test("{§emission-history} {§target-group}: a program without NOTEs replays nothing, whatever its targets", () => {
    const source = PlurnkParser.frame("KILL (log:///1/2/*) (worker:///draft.md) (sh:///abcd1234)", null);
    assert.equal(TurnOps.renderHistory(source, []), "");
});

test("{§emission-history}: a NOTE replays; a log KILL's distillation does not, since it lands as the log's own NOTE row", () => {
    const source = [
        PlurnkParser.frame("NOTE", "Retain this memory."),
        PlurnkParser.frame("KILL (log:///1/2/*)", "Distilled memory."),
    ].join("\n\n");
    assert.equal(TurnOps.renderHistory(source, []), PlurnkParser.frame("NOTE", "Retain this memory."));
});

test("{§emission-history}: a NOTE whose log row was retired leaves the replay, one occurrence per retired row", () => {
    const kept = PlurnkParser.frame("NOTE", "Kept.");
    const twice = PlurnkParser.frame("NOTE", "Said twice.");
    const source = [twice, kept, twice].join("\n\n");
    assert.equal(TurnOps.renderHistory(source, [], ["Said twice.", "Kept.", "Said twice."]), source, "every row visible, every NOTE replays");
    assert.equal(TurnOps.renderHistory(source, [], ["Kept.", "Said twice."]), `${twice}\n\n${kept}`, "one retired row removes one occurrence of its body");
    assert.equal(TurnOps.renderHistory(source, [], []), "", "no visible rows, nothing replays");
});

test("{§emission-history} {§executor-heading}: explicit executor headings remain readable without current registration", () => {
    const calls = [
        PlurnkParser.frame("sh", "printf '%s\\n' finished"),
        PlurnkParser.frame("gitea (list_issues)", '{"query":"all"}'),
        PlurnkParser.frame("a-removed-plugin (skill://example/task.js)", null),
    ].join("\n\n");
    const note = PlurnkParser.frame("NOTE", "Log memory.");
    assert.equal(TurnOps.renderHistory(`${calls}\n\n${note}`, ["sh", "gitea", "a-removed-plugin"]), note, "the admitted executors parse the frozen program; its calls are omitted and its NOTE replays");
    assert.equal(TurnOps.renderHistory(`${calls}\n\n${note}`, []), note, "explicit invocation syntax does not depend on registration");
    assert.equal(TurnOps.renderEmission(TurnOps.parseInternal(calls)), calls, "every frozen header and body stays whole");
});

test("{§emission-history} {§executor-heading}: slotless executors retain their admitted identities after unregistration", () => {
    const call = PlurnkParser.frame("a-removed-plugin", "The complete tool input.");
    const note = PlurnkParser.frame("NOTE", "Log memory.");
    const source = `${call}\n\n${note}`;
    assert.equal(TurnOps.renderHistory(source, ["a-removed-plugin"]), note);
    assert.equal(TurnOps.renderEmission(TurnOps.parseInternal(source, { executors: ["a-removed-plugin"] })), source);
    assert.throws(() => TurnOps.renderHistory(source, []), { name: "SyntaxError", message: /Core programs contain only Operation Syntax OPs/u },
        "a lost admitted identity makes the slotless call quoted text, not a different executable program");
});

test("{§outside-text} comments outside operation fences are not part of a reply", () => {
    const emitted = [
        `${PlurnkParser.frame("EDIT (worker:///notes.md)", "complete body")} <!-- imitated aside -->`,
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

test("TurnOps: internal source preserves trailing body newlines across a section boundary", () => {
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
    assert.equal((parsed[0] as EditStatement).body, edit.body);
});
