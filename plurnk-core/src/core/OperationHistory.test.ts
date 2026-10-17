import assert from "node:assert/strict";
import test from "node:test";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import OperationHistory from "./OperationHistory.ts";
import type PacketWire from "./packet-wire.ts";

const frame = PlurnkParser.frame;
type Entry = ReturnType<typeof PacketWire.entryView>;
const announcement: Entry = { id: 1, coordinate: "1/2/1", origin: "_plurnk", op: "READ", attrs: { kind: "emission" }, folded: [] };
const row = (sequence: number, op: string, ordinal: unknown, body: string | null = null): Entry => ({
    id: sequence, coordinate: `1/2/${sequence}`, origin: "model", op, folded: [],
    tx: { body }, rx: { status: 200 }, attrs: ordinal === undefined ? {} : { emissionIndex: ordinal },
});
const history = (content: string, entries: Entry[], executors: string[] = []) =>
    OperationHistory.project([announcement, ...entries], [{ id: 1, content, executors: JSON.stringify(executors) }]);

test("{§emission-history}: equal bodies do not confuse reasoning, repeated content, or curation", () => {
    const first = frame("NOTE <!-- first -->", "Same memory.");
    const second = frame("NOTE <!-- second -->", "Same memory.");
    const reasoning = row(2, "NOTE", undefined, "Same memory.");
    const firstRow = row(3, "NOTE", 0, "Same memory.");
    const secondRow = row(4, "NOTE", 1, "Same memory.");
    assert.deepEqual([...history(`${first}\n\n${second}`, [reasoning, firstRow, secondRow]).operations], [["1/2/3", first], ["1/2/4", second]]);
    assert.deepEqual([...history(`${first}\n\n${second}`, [reasoning, secondRow]).operations], [["1/2/4", second]], "retiring the first occurrence keeps the second identity, not the first matching text");
});

test("{§emission-history} {§bulk-resource-targeting}: a fan-out replays once with its first surviving receipt", () => {
    const operation = frame("READ (worker:///case-*.txt)", null);
    const first = row(2, "READ", 0);
    const second = row(3, "READ", 0);
    const both = history(operation, [first, second]);
    assert.deepEqual([...both.operations], [["1/2/2", operation]]);
    assert.deepEqual([...both.paired.keys()], ["1/2/2", "1/2/3"]);
    assert.deepEqual([...history(operation, [second]).operations], [["1/2/3", operation]]);
});

test("{§emission-history}: missing legacy provenance leaves a receipt self-describing; malformed recorded provenance fails at its owner", () => {
    const operation = frame("NOTE", "Memory.");
    assert.equal(history(operation, [row(2, "NOTE", undefined, "Memory.")]).paired.size, 0);
    for (const ordinal of [-1, 0.5, 1, "0", null]) {
        assert.throws(() => history(operation, [row(2, "NOTE", ordinal, "Memory.")]), /ordinal must address its frozen emission/u);
    }
});

test("{§emission-history}: body curation suppresses the whole replay, never an executable body-redacted example", () => {
    const note = row(2, "NOTE", 0, "Removed.\nRetained.");
    note.folded = [[1, 1]];
    assert.equal(history(frame("NOTE", "Removed.\nRetained."), [note]).paired.size, 0);
});

test("{§emission-history} {§executor-heading}: historical executor identities survive registry removal", () => {
    for (const [header, executors] of [["removed-runtime", ["removed-runtime"]], ["removed-runtime (tool)", []]] as const) {
        const operation = frame(header, "Full tool input.\n```NOTE\nA literal example.\n```");
        assert.deepEqual([...history(operation, [row(2, "removed-runtime", 0, "Full tool input.")], [...executors]).operations.values()], [operation]);
    }
});

test("{§emission-history} {§log-kill-distillation}: a failed curation request replays without duplicating its separately recorded NOTE", () => {
    const operation = frame("KILL (log:///9/9/9)", "Still worth remembering.");
    const failed = { ...row(2, "KILL", 0), rx: { status: 404 } };
    const distilled = row(3, "NOTE", undefined, "Still worth remembering.");
    const projected = history(operation, [failed, distilled]);
    assert.deepEqual([...projected.operations.values()], [frame("KILL (log:///9/9/9)", null)]);
    assert.deepEqual([...projected.paired.keys()], ["1/2/2"]);
});
