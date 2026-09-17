import assert from "node:assert/strict";
import test from "node:test";
import { PlurnkParser } from "../../src/index.ts";

const frame = (op: string, body = "") => PlurnkParser.frame(op, body);
const operations = (source: string) => {
    const result = PlurnkParser.parse(source);
    assert.deepEqual(result.items.filter((item) => item.kind === "error"), []);
    assert.equal(result.unparsedTail, undefined);
    return result.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
};

test("#713: lifecycle verbs have literal bodies and retain tolerant disposition placement", () => {
    for (const op of ["WAIT", "DONE", "FAIL"]) {
        const body = "A conclusion, not a JSON task inventory.";
        const parsed = operations([frame(op, body), frame("NOTE", "Keep this determination."), frame("READ (notes.md)")].join("\n\n"));
        assert.deepEqual(parsed.map((statement) => statement.op), [op, "NOTE", "READ"]);
        assert.equal("body" in parsed[0]! ? parsed[0].body : undefined, body);
        assert.equal("body" in parsed[1]! ? parsed[1].body : undefined, "Keep this determination.");
    }
});

test("#713: NOTE-only turns continue without a synthetic lifecycle declaration", () => {
    const parsed = operations(frame("NOTE", "The test failed before our change."));
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0]!.op, "NOTE");
    assert.equal(PlurnkParser.stringify(parsed), frame("NOTE", "The test failed before our change."));
});

test("#713: reasoning admits only NOTE, preserving literal nested examples", () => {
    const reasoning = [
        "I should remember the observation.",
        frame("NOTE", "The first probe ruled out the network."),
        frame("EDIT (not-a-real-write)", "Never execute a reasoned edit."),
        frame("SEND", frame("NOTE", "This is a quoted example, not a note.")),
        frame("NOTE", "Try the local parser next."),
    ].join("\n\n");
    const notes = PlurnkParser.parseReasoningNotes(reasoning);
    assert.deepEqual(notes.map((note) => note.body), [
        "The first probe ruled out the network.",
        "Try the local parser next.",
    ]);
    assert.ok(notes.every((note) => note.op === "NOTE"));
});

test("{§reasoning-notes}: enclosing code fences protect quoted NOTE examples", () => {
    const example = frame("NOTE", "This is quoted, not retained memory.");
    for (const enclosing of ["```", "`````", "`````text", "`````sh", "~~~", "~~~markdown"]) {
        const closer = enclosing.match(/^[`~]+/)![0];
        const quoted = `${enclosing}\n${example}\n${closer}`;
        assert.deepEqual(PlurnkParser.parseReasoningNotes(quoted), [], enclosing);
    }
    const source = [
        `\`\`\`\`\`text\n${example}\n\`\`\`\`\``,
        frame("NOTE", "This is the actual determination."),
    ].join("\n\n");
    assert.deepEqual(PlurnkParser.parseReasoningNotes(source).map(({ body }) => body), ["This is the actual determination."]);
    assert.deepEqual(PlurnkParser.parseReasoningNotes(example.split("\n").map((line) => `> ${line}`).join("\n")), []);
});
