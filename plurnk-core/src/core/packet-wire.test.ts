import test from "node:test";
import assert from "node:assert/strict";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import PacketWire from "./packet-wire.ts";

const aside = "<!-- preview; the whole statement ran: READ (ops://analyst/1/2) for all of it -->";

test("{§emission-row} the wire drops NOTE and WAIT blocks and keeps every other block, whole and in order", () => {
    const read = PlurnkParser.frame("READ (worker:///a.md) <1,-1> <!-- look -->", null);
    const edit = PlurnkParser.frame("EDIT (worker:///a.md)", "A literal example:\n```NOTE\nnot a block\n```\nReplacement text.");
    const cut = `${PlurnkParser.frame("SEND (worker://helper)", "head only")} ${aside}`;
    const frozen = [
        PlurnkParser.frame("NOTE <!-- remember -->", "Remember this."),
        read,
        edit,
        PlurnkParser.frame("WAIT <60>", "Awaiting the child."),
        cut,
        PlurnkParser.frame("KILL", "The answer."),
    ].join("\n\n");
    assert.equal(PacketWire.deliveredEmission(frozen), [read, edit, cut, PlurnkParser.frame("KILL", "The answer.")].join("\n\n"),
        "a NOTE line nested inside a longer fence is body text, and a preview note stays on its closer");
});

test("{§emission-row} an emission of only NOTE and WAIT delivers nothing", () => {
    assert.equal(PacketWire.deliveredEmission(`${PlurnkParser.frame("NOTE", "Only a note.")}\n\n${PlurnkParser.frame("WAIT", null)}`), "");
});

test("{§emission-row} a projection frozen in an earlier era is read back by its fences alone", () => {
    const stub = "```NOTE\n> [!NOTE]\n> Body content REDACTED from history.\n```\n\n```KILL\n> [!NOTE]\n> Body content REDACTED from history.\n```";
    assert.equal(PacketWire.deliveredEmission(stub), "```KILL\n> [!NOTE]\n> Body content REDACTED from history.\n```");
    assert.equal(PacketWire.deliveredEmission("```READ (a.md)\n```\n\n```NOTE\n```"), "```READ (a.md)\n```");
});

test("{§emission-row} a frozen projection that is not fenced blocks fails hard", () => {
    assert.throws(() => PacketWire.deliveredEmission(""), /an emission block opens with a fence/u, "an admitted emission is never empty");
    assert.throws(() => PacketWire.deliveredEmission("free text"), /an emission block opens with a fence/u);
    assert.throws(() => PacketWire.deliveredEmission("```READ (a.md)\nunclosed"), /an emission block closes with its own fence/u);
});
