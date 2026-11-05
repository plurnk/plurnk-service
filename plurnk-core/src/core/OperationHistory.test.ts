import assert from "node:assert/strict";
import test from "node:test";
import OperationHistory from "./OperationHistory.ts";
import type PacketWire from "./packet-wire.ts";

type Entry = ReturnType<typeof PacketWire.entryView>;
const announcement: Entry = { id: 1, coordinate: "1/2/1", origin: "_plurnk", op: "read", attrs: { kind: "emission" }, folded: [] };
const row = (sequence: number, op: string, ordinal: unknown, body: string | null = null): Entry => ({
    id: sequence, coordinate: `1/2/${sequence}`, origin: "model", op, folded: [],
    tx: { body }, rx: { status: 200 }, attrs: ordinal === undefined ? {} : { emissionIndex: ordinal },
});
const history = (content: string, entries: Entry[], executors: string[] = []) =>
    OperationHistory.project([announcement, ...entries], [{ id: 1, content, executors: JSON.stringify(executors) }]);

test("{§emission-history}: equal bodies do not confuse reasoning, repeated content, or curation", () => {
    const first = 'await plurnk.note({"text":"Same memory."}); // first';
    const second = 'await plurnk.note({"text":"Same memory."}); // second';
    const reasoning = row(2, "note", undefined, "Same memory.");
    const firstRow = row(3, "note", 0, "Same memory.");
    const secondRow = row(4, "note", 1, "Same memory.");
    assert.deepEqual([...history(`${first}\n\n${second}`, [reasoning, firstRow, secondRow]).operations], [["1/2/3", first], ["1/2/4", second]]);
    assert.deepEqual([...history(`${first}\n\n${second}`, [reasoning, secondRow]).operations], [["1/2/4", second]], "retiring the first occurrence keeps the second identity, not the first matching text");
});

test("{§emission-history} {§op-methods-op-dispatch}: a fan-out replays once with its first surviving receipt", () => {
    const operation = 'await plurnk.read({"path":"workspace:///case-*.txt"});';
    const first = row(2, "read", 0);
    const second = row(3, "read", 0);
    const both = history(operation, [first, second]);
    assert.deepEqual([...both.operations], [["1/2/2", operation]]);
    assert.deepEqual([...both.paired.keys()], ["1/2/2", "1/2/3"]);
    assert.deepEqual([...history(operation, [second]).operations], [["1/2/3", operation]]);
});

test("{§emission-history}: missing legacy provenance leaves a receipt self-describing; malformed recorded provenance fails at its owner", () => {
    const operation = 'await plurnk.note({"text":"Memory."});';
    assert.equal(history(operation, [row(2, "note", undefined, "Memory.")]).paired.size, 0);
    for (const ordinal of [-1, 0.5, 1, "0", null]) {
        assert.throws(() => history(operation, [row(2, "note", ordinal, "Memory.")]), /ordinal must address its frozen emission/u);
    }
});

test("{§emission-history}: body curation suppresses the whole replay, never an executable body-redacted example", () => {
    const note = row(2, "note", 0, "Removed.\nRetained.");
    note.folded = [[1, 1]];
    assert.equal(history('await plurnk.note({"text":"Removed.\\nRetained."});', [note]).paired.size, 0);
});

test("{§emission-history} {§fence-pairing}: historical executor identities survive registry removal", () => {
    for (const [operation, executors] of [
        ['await plurnk["removed-runtime"]("Full tool input.\\n```NOTE\\nA literal example.\\n```");', ["removed-runtime"]],
        ['await removed-runtime.tool("Full tool input.\\n```NOTE\\nA literal example.\\n```");', []],
    ] as const) {
        assert.deepEqual([...history(operation, [row(2, "removed-runtime", 0, "Full tool input.")], [...executors]).operations.values()], [operation]);
    }
});

test("{§emission-history} {§log-kill-scope}: a failed curation request replays without duplicating its separately recorded NOTE", () => {
    const operation = 'await plurnk.kill({"path":"log:///9/9/9","note":"Still worth remembering."});';
    const failed = { ...row(2, "kill", 0), rx: { status: 404 } };
    const distilled = row(3, "note", undefined, "Still worth remembering.");
    const projected = history(operation, [failed, distilled]);
    assert.deepEqual([...projected.operations.values()], ['await plurnk.kill({"path":"log:///9/9/9"});']);
    assert.deepEqual([...projected.paired.keys()], ["1/2/2"]);
});

test("{§emission-history}: a turn's surviving operations replay together, in program order, before its first surviving receipt", () => {
    const note = 'await plurnk.note({"text":"Read, then fix."}); // plan';
    const read = 'await plurnk.read({"path":"src/a.ts","range":"1,4"});';
    const edit = 'await plurnk.edit({"path":"src/a.ts","range":"2","content":"fixed"});';
    const program = `${note}\n\n${read}\n\n${edit}`;
    const rows = [row(2, "note", 0, "Read, then fix."), row(3, "read", 1), row(4, "edit", 2, "fixed")];
    const projected = history(program, rows);
    assert.deepEqual([...projected.turns], [["1/2/2", `${note}\n\n${read}\n\n${edit}`]], "one assistant message for the turn, anchored at its first receipt");
    assert.deepEqual([...projected.operations.keys()], ["1/2/2", "1/2/3", "1/2/4"], "each operation keeps its own receipt for accounting");
    assert.deepEqual([...history(program, rows.slice(1)).turns], [["1/2/3", `${read}\n\n${edit}`]], "a retired operation leaves the turn's replay, which moves to the first surviving receipt");
    const later = { ...row(2, "read", 0), coordinate: "1/3/2" };
    const twoTurns = OperationHistory.project([announcement, ...rows, { ...announcement, id: 9, coordinate: "1/3/1" }, later],
        [{ id: 1, content: program, executors: "[]" }, { id: 9, content: read, executors: "[]" }]);
    assert.deepEqual([...twoTurns.turns.keys()], ["1/2/2", "1/3/2"], "each turn has its own message");
});
