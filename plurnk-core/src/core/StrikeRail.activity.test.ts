import test from "node:test";
import assert from "node:assert/strict";
import { PlurnkParser, type OperationResult } from "@plurnk/plurnk-contracts";
import StrikeRail from "./StrikeRail.ts";

const statements = (source: string) => {
    const parsed = PlurnkParser.parseStatements(source);
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
        ["```READ (https://example.test/) {accept=text/plain}```", "```READ (https://example.test/) {accept=application/json}```"],
        ["```SEND (worker://child)\none\n```", "```SEND (worker://child)\ntwo\n```"],
        ["```WORK (worker://child)\none\n```", "```WORK (worker://child)\ntwo\n```"],
        ["```READ (a)```\n```EDIT (b) <1>\nx\n```", "```EDIT (b) <1>\nx\n```\n```READ (a)```"],
    ]) {
        assert.notEqual(fingerprint(first!), fingerprint(second!), `${first} differs from ${second}`);
    }
});

test("{§engine-cycle-evidence} source decoration does not disguise a cycle", () => {
    assert.equal(fingerprint("```READ (a) <1>```\n```TASK\n[{\"content\":\"continue\",\"status\":\"in_progress\"}]\n```"),
        fingerprint("\n```READ (a) <1> <!-- another annotation -->```\n```TASK\n[{\"content\":\"continue\",\"status\":\"in_progress\"}]\n```"));
});

test("{§engine-cycle-evidence} native inventory changes are workflow changes", () => {
    const task = (content: string, status: string) => PlurnkParser.frame("TASK", JSON.stringify([{ content, status }]));
    assert.notEqual(fingerprint(task("Inspect.", "pending")), fingerprint(task("Inspect.", "in_progress")));
    assert.notEqual(fingerprint(task("Inspect.", "in_progress")), fingerprint(task("Implement.", "in_progress")));
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
