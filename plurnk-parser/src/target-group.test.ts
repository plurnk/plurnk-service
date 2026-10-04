import test from "node:test";
import assert from "node:assert/strict";
import type { KillStatement, ReadStatement } from "@plurnk/plurnk-contracts";
import PlurnkParser from "./PlurnkParser.ts";

const only = <T extends ReadStatement | KillStatement>(source: string, op: T["op"]): T => {
    const parsed = PlurnkParser.parse(source);
    const errors = parsed.items.filter((item) => item.kind === "error" && item.error.severity === "error");
    assert.deepEqual(errors, [], `${source} parses clean`);
    const statement = parsed.items.find((item) => item.kind === "statement" && item.statement.op === op);
    if (statement?.kind !== "statement") throw new Error(`${source} did not parse ${op}`);
    return statement.statement as T;
};
const firstError = (source: string, client = false): string => {
    const parsed = client ? PlurnkParser.parseClient(source) : PlurnkParser.parse(source);
    const error = parsed.items.find((item) => item.kind === "error" && item.error.severity === "error");
    return error?.kind === "error" ? error.error.message : "";
};

test("{§target-group}: READ and KILL take several (path) slots; each binds the scope and metadata that follow it", () => {
    const kill = only<KillStatement>('````KILL (log:///1/1/2/FIND) (log:///1/2/3/READ) <23,-1> (log:///1/1/6/FIND) [{"keep":1}] <!-- free the room -->````', "KILL");
    assert.ok(kill.group !== undefined, "more than one slot is a group");
    assert.deepEqual(kill.group.map(({ target }) => target.raw), ["log:///1/1/2/FIND", "log:///1/2/3/READ", "log:///1/1/6/FIND"]);
    assert.equal(kill.target?.raw, "log:///1/1/2/FIND", "the statement's own target is the first slot");
    assert.equal(kill.lineMarker, null, "the first slot carries no scope");
    assert.deepEqual(kill.group[1].lineMarker, { marks: [23, -1] }, "the scope binds to the slot it follows");
    assert.equal(kill.group[2].lineMarker, null);
    assert.deepEqual(kill.group[2].metadata, ['{"keep":1}'], "so does metadata");
    assert.equal(kill.aside, "free the room");
    const read = only<ReadStatement>("````READ (a.md) <1,3> (b.md)````", "READ");
    assert.deepEqual(read.group?.map(({ target, lineMarker }) => [target.raw, lineMarker?.marks ?? null]), [["a.md", [1, 3]], ["b.md", null]]);
    assert.deepEqual(read.lineMarker, { marks: [1, 3] }, "the first member repeats the statement's scope");
});

test("{§target-group}: a naked pattern on the heading is the group's; one slot is no group", () => {
    const read = only<ReadStatement>("````READ (a.md) (b.md) /TODO/````", "READ");
    assert.equal(read.matcher?.raw, "/TODO/");
    assert.deepEqual(read.group?.map(({ matcher }) => matcher), [null, null], "no member owns the heading's pattern");
    const own = only<ReadStatement>('````READ (a.md) [{"pattern": "/one/"}] (b.md)````', "READ");
    assert.equal(own.matcher?.raw, "/one/", "a pattern option on the first slot is the statement's matcher as always");
    assert.equal(own.group?.[0].matcher?.raw, "/one/", "and that member's own");
    assert.equal(own.group?.[1].matcher, null);
    const single = only<ReadStatement>("````READ (a.md) <1,3>````", "READ");
    assert.equal("group" in single, false, "one slot: the statement as it always was");
});

test("{§target-group} {§statement-rendering}: a group renders back member by member and reparses equal", () => {
    for (const source of [
        "```KILL (log:///1/1/2/FIND) (log:///1/2/3/READ) <23,-1> (log:///1/1/6/FIND) <!-- free the room -->\n```",
        "```READ (a.md) <1,3> (b.md) /TODO/\n```",
        '```READ (a.md) [{"pattern":"/one/"}] (b.md) [{"keep":1}]\n```',
        "```KILL (log:///1/2/3/READ) (log:///1/3/2/FIND)\nBoth held the same fact: the host is db.internal.\n```",
    ]) {
        const parsed = PlurnkParser.parse(source);
        const statements = parsed.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
        assert.equal(statements.length, 1, source);
        const rendered = PlurnkParser.stringify(statements);
        assert.equal(rendered, source, "the canonical rendering is the authored form");
        assert.deepEqual(PlurnkParser.parse(rendered).items, parsed.items);
    }
});

test("{§target-group}: a distilling body stays on a grouped log KILL; every other operation keeps one slot", () => {
    const kill = only<KillStatement>("````KILL (log:///1/2/3/READ) (log:///1/3/2/FIND)\nBoth held the same fact.\n````", "KILL");
    assert.equal(kill.body, "Both held the same fact.");
    assert.match(firstError("````EDIT (a.md) (b.md)````"), /slot opener/u, "EDIT takes one slot");
    assert.match(firstError("````FIND (a.md) (b.md)````"), /slot opener/u, "FIND takes one slot");
    assert.match(firstError("````LOOK (a.md) (b.md)````", true), /slot opener/u, "LOOK takes one slot");
    assert.match(firstError("````KILL (a.md) <1,3> <4,5> (b.md)````"), /one scope/u, "a member still takes one scope");
});
