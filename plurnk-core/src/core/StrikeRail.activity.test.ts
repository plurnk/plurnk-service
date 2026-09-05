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
        ["### EDIT0 (notes.md) <1>\none", "### EDIT0 (notes.md) <1>\ntwo"],
        ["### EDIT0 (notes.md) <1>\none", "### EDIT0 (notes.md) <2>\none"],
        ["### COPY0 (a) <1> (b) <0>", "### COPY0 (a) <1> (c) <0>"],
        ["### MOVE0 (a) <1> (b) <0>", "### MOVE0 (a) <2> (b) <0>"],
        ["### COPY0 (a) <1> (b) <0>", "### COPY0 (a) <1> (b) <-1>"],
        ["### READ0 (https://example.test/) {accept=text/plain}", "### READ0 (https://example.test/) {accept=application/json}"],
        ["### SEND0 (worker://child)\none", "### SEND0 (worker://child)\ntwo"],
        ["### WORK0 (worker://child)\none", "### WORK0 (worker://child)\ntwo"],
        ["### READ0 (a)\n### EDIT0 (b) <1>\nx", "### EDIT0 (b) <1>\nx\n### READ0 (a)"],
    ]) {
        assert.notEqual(fingerprint(first!), fingerprint(second!), `${first} differs from ${second}`);
    }
});

test("{§engine-cycle-evidence} framing prose and source decoration do not disguise a cycle", () => {
    assert.equal(fingerprint("## PLAN0\n[]\n### READ0 (a) <1>\n### SEND0 (NEXT)\ncontinue"),
        fingerprint("\n## PLANx <!-- updated -->\nremember this\n### READx (a) <1> <!-- another annotation -->\n### SENDx (NEXT)\ncontinue differently"));
});

test("{§engine-cycle-evidence} changing observations distinguish otherwise identical requests", () => {
    const source = "### READ0 (notes.md)";
    assert.notEqual(fingerprint(source, [{ status: 200, content: "one" }]),
        fingerprint(source, [{ status: 200, content: "two" }]));
    assert.notEqual(fingerprint(source, [{ status: 200, content: "one" }]),
        fingerprint(source, [{ status: 304 }]));
    assert.equal(fingerprint(source, [{ status: 200, content: "one" }]),
        fingerprint(source, [{ content: "one", status: 200 }]));
});

test("{§engine-cycle-evidence} engine-assigned problem instances do not conceal repeated failures", () => {
    const source = "### READ0 (missing.md)";
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
    assert.throws(() => fingerprint("### READ0 (a)", []), /cycle evidence requires one result per executed operation/);
});
