import assert from "node:assert/strict";
import test from "node:test";
import OperationHistory from "./OperationHistory.ts";
import type PacketWire from "./packet-wire.ts";

type Entry = ReturnType<typeof PacketWire.entryView>;
const announcement: Entry = { id: 1, coordinate: "1/2/1", origin: "_plurnk", op: "read", attrs: { kind: "emission" }, folded: [] };
const row = (sequence: number, op: string, ordinal: unknown, body: string | null = null, status = 200): Entry => ({
    id: sequence, coordinate: `1/2/${sequence}`, origin: "model", op, status, folded: [],
    tx: { body }, rx: { status }, attrs: ordinal === undefined ? {} : { emissionIndex: ordinal },
});
const history = (content: string, entries: Entry[], executors: string[] = []) =>
    OperationHistory.project([announcement, ...entries], [{ id: 1, content, executors: JSON.stringify(executors) }]);

const expectedWire = (ordinal: number, server: string, tool: string, args: Record<string, unknown>, aside?: string, turn = "1_2") => JSON.stringify({
    id: `call_${turn}_${ordinal}`,
    name: "mcp",
    arguments: {
        server,
        tool,
        arguments: args,
        ...(aside === undefined ? {} : { aside }),
    },
});

test("{§emission-history}: equal bodies do not confuse reasoning, repeated content, or curation", () => {
    const first = 'plurnk.note({"text":"Same memory."}) // first';
    const second = 'plurnk.note({"text":"Same memory."}) // second';
    const reasoning = row(2, "note", undefined, "Same memory.");
    const firstRow = row(3, "note", 0, "Same memory.");
    const secondRow = row(4, "note", 1, "Same memory.");
    const firstWire = expectedWire(0, "plurnk", "note", { text: "Same memory." }, "first");
    const secondWire = expectedWire(1, "plurnk", "note", { text: "Same memory." }, "second");
    assert.deepEqual([...history(`${first}\n\n${second}`, [reasoning, firstRow, secondRow]).operations], [["1/2/3", firstWire], ["1/2/4", secondWire]]);
    assert.deepEqual([...history(`${first}\n\n${second}`, [reasoning, secondRow]).operations], [["1/2/4", secondWire]], "retiring the first occurrence keeps the second identity, not the first matching text");
});

test("{§emission-history} {§op-methods-op-dispatch}: a fan-out replays once with all surviving receipt coordinates", () => {
    const operation = 'plurnk.read({"path":"workspace:///case-*.txt"})';
    const wire = expectedWire(0, "plurnk", "read", { path: "workspace:///case-*.txt" });
    const first = row(2, "read", 0);
    const second = row(3, "read", 0);
    const both = history(operation, [first, second]);
    assert.deepEqual([...both.operations], [["1/2/2", wire]]);
    assert.deepEqual([...both.paired.keys()], ["1/2/2", "1/2/3"]);
    assert.deepEqual(both.turns.get("1/2/1")?.map((c) => c.receiptCoordinates), [["1/2/2", "1/2/3"]]);
    assert.deepEqual([...history(operation, [second]).operations], [["1/2/3", wire]]);
});

test("{§emission-history}: missing legacy provenance leaves a receipt self-describing; malformed recorded provenance fails at its owner", () => {
    const operation = 'plurnk.note({"text":"Memory."})';
    assert.equal(history(operation, [row(2, "note", undefined, "Memory.")]).paired.size, 0);
    assert.equal(history(operation, [{ ...row(2, "send", 5, "pong"), origin: "_plurnk", source: "session://pong" }]).paired.size, 0,
        "ambient rows from another session carry a source and never address the observer turn's emission");
    for (const ordinal of [-1, 0.5, 1, "0", null]) {
        assert.throws(() => history(operation, [row(2, "note", ordinal, "Memory.")]), /ordinal must address its frozen emission/u);
    }
});

test("{§emission-history}: body curation suppresses the whole replay, never an executable body-redacted example", () => {
    const note = row(2, "note", 0, "Removed.\nRetained.");
    note.folded = [[1, 1]];
    assert.equal(history('plurnk.note({"text":"Removed.\\nRetained."})', [note]).paired.size, 0);
});

test("{§emission-history} {§expression-boundaries}: historical executor identities survive registry removal", () => {
    const bodyText = 'Full tool input.\nplurnk.note({"text":"A literal example."})';
    const plurnkRuntime = `plurnk["removed-runtime"](${JSON.stringify(bodyText)})`;
    const externalRuntime = `removed-runtime.tool(${JSON.stringify({ input: bodyText })})`;
    assert.deepEqual(
        [...history(plurnkRuntime, [row(2, "removed-runtime", 0, "Full tool input.")], ["removed-runtime"]).operations.values()],
        [expectedWire(0, "plurnk", "removed-runtime", { body: bodyText })],
    );
    assert.deepEqual(
        [...history(externalRuntime, [row(2, "removed-runtime", 0, "Full tool input.")], []).operations.values()],
        [expectedWire(0, "removed-runtime", "tool", { input: bodyText })],
    );
});

test("{§emission-history} {§log-kill-scope}: active=0 log curation omits its kill call while replaying active rows in the same turn", () => {
    const operation = 'plurnk.kill({"path":"log:///9/9/9"}) // reclaim\n\nplurnk.note({"text":"Still worth remembering."})';
    const killWire = expectedWire(0, "plurnk", "kill", { path: "log:///9/9/9" }, "reclaim");
    const noteWire = expectedWire(1, "plurnk", "note", { text: "Still worth remembering." });
    const failed = row(2, "kill", 0, null, 404);
    const keptNote = row(3, "note", 1, "Still worth remembering.");
    const projected = history(operation, [failed, keptNote]);
    assert.deepEqual([...projected.operations.values()], [killWire, noteWire]);
    assert.deepEqual([...projected.paired.keys()], ["1/2/2", "1/2/3"]);
    assert.equal(projected.turns.get("1/2/1")?.[0]?.isError, true);
    const settled = OperationHistory.project([announcement, keptNote], [{ id: 1, content: operation, executors: "[]" }]);
    assert.deepEqual(settled.turns.get("1/2/1")?.map((c) => c.serialized), [noteWire], "active=0 log curation leaves zero replayed kill calls while active NOTE still replays");
});

test("{§emission-history}: a turn's surviving operations replay together, in program order, immediately after its emission row", () => {
    const note = 'plurnk.note({"text":"Read, then fix."}) // plan';
    const read = 'plurnk.read({"path":"src/a.ts","range":"1,4"})';
    const edit = 'plurnk.edit({"path":"src/a.ts","range":"2","text":"fixed"})';
    const program = `${note}\n\n${read}\n\n${edit}`;
    const rows = [row(2, "note", 0, "Read, then fix."), row(3, "read", 1), row(4, "edit", 2, "fixed")];
    const projected = history(program, rows);
    assert.deepEqual(
        projected.turns.get("1/2/1")?.map((c) => c.serialized),
        [
            expectedWire(0, "plurnk", "note", { text: "Read, then fix." }, "plan"),
            expectedWire(1, "plurnk", "read", { path: "src/a.ts", range: "1,4" }),
            expectedWire(2, "plurnk", "edit", { path: "src/a.ts", range: "2", text: "fixed" }),
        ],
        "one assistant tool-call list for the turn, anchored at its emission row",
    );
    assert.deepEqual([...projected.operations.keys()], ["1/2/2", "1/2/3", "1/2/4"], "each operation keeps its own receipt for accounting");
    assert.deepEqual(
        history(program, rows.slice(1)).turns.get("1/2/1")?.map((c) => c.serialized),
        [
            expectedWire(1, "plurnk", "read", { path: "src/a.ts", range: "1,4" }),
            expectedWire(2, "plurnk", "edit", { path: "src/a.ts", range: "2", text: "fixed" }),
        ],
        "a retired operation leaves the turn's replay anchored at its emission row",
    );
    const later = { ...row(2, "read", 0), coordinate: "1/3/2" };
    const twoTurns = OperationHistory.project([announcement, ...rows, { ...announcement, id: 9, coordinate: "1/3/1" }, later],
        [{ id: 1, content: program, executors: "[]" }, { id: 9, content: read, executors: "[]" }]);
    assert.deepEqual([...twoTurns.turns.keys()], ["1/2/1", "1/3/1"], "each turn has its own message");
});

test("{§emission-history} {§tokenomics}: provider replay metadata extracts from assistant_raw without inflating serialized operation text", () => {
    const read = 'plurnk.read({"path":"src/a.ts"})';
    const note = 'plurnk.note({"text":"Checked."})';
    const program = `${read}\n\n${note}`;
    const sig = Buffer.from("gemini-sig-01").toString("base64");
    const assistantRaw = JSON.stringify({
        content: "",
        wire: {
            replay: {
                api: "google-generative-ai",
                provider: "google",
                model: "gemini-4-hydrogen",
                thinking: [{ thinking: "Inspect a.ts." }],
            },
            toolCalls: [
                { index: 0, id: "raw_0", type: "function", name: "mcp", arguments: "{}", thoughtSignature: sig },
                { index: 1, id: "raw_1", type: "function", name: "mcp", arguments: "{}" },
            ],
        },
    });
    const projected = OperationHistory.project(
        [announcement, row(2, "read", 0), row(3, "note", 1, "Checked.")],
        [{ id: 1, content: program, executors: "[]", assistant_raw: assistantRaw }],
    );
    assert.equal(projected.operations.get("1/2/2"), expectedWire(0, "plurnk", "read", { path: "src/a.ts" }), "serialized operation excludes thoughtSignature");
    assert.deepEqual(projected.assistantReplay.get("emission-history/1/2/1"), {
        api: "google-generative-ai",
        provider: "google",
        model: "gemini-4-hydrogen",
        thinking: [{ thinking: "Inspect a.ts." }],
        toolCallSignatures: { call_1_2_0: sig },
    });
});
