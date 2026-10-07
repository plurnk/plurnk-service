import test from "node:test";
import assert from "node:assert/strict";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import PacketWire from "./packet-wire.ts";

test("{§emission-row} bodies are not replayed: a bodied block keeps its heading and an empty closer, a bodiless one is one line", () => {
    const edit = PlurnkParser.frame("EDIT (worker:///a.md)", "A literal example:\n```NOTE\nnot a block\n```\nReplacement text.");
    const frozen = [
        PlurnkParser.frame("NOTE <!-- remember -->", "Remember this."),
        PlurnkParser.frame("READ (worker:///a.md) <1,-1> <!-- look -->", null),
        edit,
        PlurnkParser.frame("WAIT <60>", "Awaiting the child."),
        PlurnkParser.frame("SEND (worker://helper)", "The task."),
        PlurnkParser.frame("MOVE (worker:///a.md) (worker:///b.md)", null),
    ].join("\n\n");
    const fence = edit.split("\n")[0]!.match(/^`+/u)![0];
    assert.equal(PacketWire.deliveredEmission(frozen), [
        "```READ (worker:///a.md) <1,-1> <!-- look -->```",
        `${fence}EDIT (worker:///a.md)\n${fence}`,
        "```SEND (worker://helper)\n```",
        "```MOVE (worker:///a.md) (worker:///b.md)```",
    ].join("\n\n"), "a NOTE line nested inside a longer fence is body text, and the block keeps its own fence");
});

test("{§emission-row} NOTE, WAIT and the reply are not replayed: their own rows show them whole", () => {
    assert.equal(PacketWire.deliveredEmission(`${PlurnkParser.frame("NOTE", "Only a note.")}\n\n${PlurnkParser.frame("WAIT", null)}`), "");
    assert.equal(PacketWire.deliveredEmission(`${PlurnkParser.frame("SEND", "Progress.")}\n\n${PlurnkParser.frame("KILL <!-- done -->", "The answer.")}`), "");
    assert.equal(PacketWire.deliveredEmission(PlurnkParser.frame("KILL (log:///1/2/3/READ)", null)), "```KILL (log:///1/2/3/READ)```",
        "a targeted KILL curates, so it is replayed");
});

test("{§emission-row} a projection frozen in an earlier era is read back by its fences alone", () => {
    const preview = `${PlurnkParser.frame("EDIT (a.md)", "head only")} <!-- preview; the whole statement ran: READ (ops://analyst/1/2) for all of it -->`;
    assert.equal(PacketWire.deliveredEmission(preview), "```EDIT (a.md)\n```");
    assert.equal(PacketWire.deliveredEmission("```READ (a.md)\n```\n\n```NOTE\n```"), "```READ (a.md)```");
});

test("{§emission-row} a frozen projection that is not fenced blocks fails hard", () => {
    assert.throws(() => PacketWire.deliveredEmission(""), /an emission block opens with a fence/u, "an admitted emission is never empty");
    assert.throws(() => PacketWire.deliveredEmission("free text"), /an emission block opens with a fence/u);
    assert.throws(() => PacketWire.deliveredEmission("```READ (a.md)\nunclosed"), /an emission block closes with its own fence/u);
});
