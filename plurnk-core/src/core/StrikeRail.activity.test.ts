import test from "node:test";
import assert from "node:assert/strict";
import { PlurnkParser } from "@plurnk/plurnk-parser";
import { type OperationResult } from "@plurnk/plurnk-contracts";
import StrikeRail from "./StrikeRail.ts";

// Fixture executors: every fence tag this file's DSL text writes opens as an executor.
const fixtureExecutors = (text: string): readonly string[] => [...new Set([...text.matchAll(/^`{3,}[0-9]*([a-z][A-Za-z0-9_.+-]*)/gmu)].map((match) => match[1]!))];

const statements = (source: string) => {
    const parsed = PlurnkParser.parseStatements(source, { executors: fixtureExecutors(source) });
    assert.deepEqual(parsed.items.filter((item) => item.kind === "error"), []);
    return parsed.items.flatMap((item) => item.kind === "statement" ? [item.statement] : []);
};
const fingerprint = (source: string, results?: readonly OperationResult[]) =>
    StrikeRail.fingerprintTurn(statements(source), results);

test("{§engine-cycle-evidence} every operational operand distinguishes activity", () => {
    for (const [first, second] of [
        ["```EDIT (notes.md) <1>\none\n```", "```EDIT (notes.md) <1>\ntwo\n```"],
        ["```EDIT (notes.md) <1>\none\n```", "```EDIT (notes.md) <2>\none\n```"],
        ["```COPY (a) <1> (b) <0>```", "```COPY (a) <1> (c) <0>```"],
        ["```MOVE (a) <1> (b) <0>```", "```MOVE (a) <2> (b) <0>```"],
        ["```COPY (a) <1> (b) <0>```", "```COPY (a) <1> (b) <-1>```"],
        ["```READ (https://example.test/) [{\"Accept\": \"text/plain\"}]```", "```READ (https://example.test/) [{\"Accept\": \"application/json\"}]```"],
        ["```SEND (worker://child)\none\n```", "```SEND (worker://child)\ntwo\n```"],
        ["```WORK (worker://child)\none\n```", "```WORK (worker://child)\ntwo\n```"],
        ["```READ (a)```\n```EDIT (b) <1>\nx\n```", "```EDIT (b) <1>\nx\n```\n```READ (a)```"],
    ]) {
        assert.notEqual(fingerprint(first!), fingerprint(second!), `${first} differs from ${second}`);
    }
});

test("{§engine-cycle-evidence} source decoration does not disguise a cycle", () => {
    assert.equal(fingerprint("```READ (a) <1>```\n```NOTE\ncontinue\n```"),
        fingerprint("\n```READ (a) <1> <!-- another aside -->```\n```NOTE\ncontinue\n```"));
});

test("{§engine-cycle-evidence} note content and lifecycle changes distinguish authored activity", () => {
    assert.notEqual(fingerprint(PlurnkParser.frame("WAIT", "Inspect.")), fingerprint(PlurnkParser.frame("DONE", "Inspect.")));
    assert.notEqual(fingerprint(PlurnkParser.frame("NOTE", "Inspect.")), fingerprint(PlurnkParser.frame("NOTE", "Implement.")));
});

test("{§engine-cycle-evidence} a note's assigned storage coordinate does not disguise repetition", () => {
    const note = PlurnkParser.frame("NOTE", "Retain this determination.");
    assert.equal(fingerprint(note, [{ status: 200, resource: "note:///1/2/1" }]),
        fingerprint(note, [{ status: 200, resource: "note:///1/3/1" }]));
    assert.notEqual(fingerprint(note, [{ status: 200, resource: "note:///1/2/1" }]),
        fingerprint(PlurnkParser.frame("NOTE", "A different determination."), [{ status: 200, resource: "note:///1/3/1" }]));
    assert.notEqual(fingerprint(note, [{ status: 200, resource: "note:///1/2/1" }]),
        fingerprint(note, [{ status: 500 }]));
});

test("{§engine-cycle-evidence} changing observations distinguish otherwise identical requests", () => {
    const source = "```READ (notes.md)```";
    assert.notEqual(fingerprint(source, [{ status: 200, content: "one" }]),
        fingerprint(source, [{ status: 200, content: "two" }]));
    assert.notEqual(fingerprint(source, [{ status: 200, content: "one" }]),
        fingerprint(source, [{ status: 304 }]));
    assert.equal(fingerprint(source, [{ status: 200, content: "one" }]),
        fingerprint(source, [{ content: "one", status: 200 }]));
});

test("{§engine-cycle-evidence} engine-assigned problem instances do not conceal repeated failures", () => {
    const source = "```READ (missing.md)```";
    const failure = (instance: string): OperationResult => ({
        status: 404,
        problem: { type: "https://problems.plurnk.xyz/scheme/file/entry-not-found", title: "Not found", status: 404, detail: "No entry exists.", instance },
    });
    assert.equal(fingerprint(source, [failure("log:///1/2/2/READ")]),
        fingerprint(source, [failure("log:///1/3/2/READ")]));
    assert.notEqual(fingerprint(source, [failure("log:///1/2/2/READ")]),
        fingerprint(source, [{ status: 200, content: "found" }]));
});

test("{§engine-cycle-evidence} dispatch results must correspond to the executed statements", () => {
    assert.throws(() => fingerprint("```READ (a)```", []), /cycle evidence requires one result per executed operation/);
});
