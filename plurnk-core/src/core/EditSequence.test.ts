import assert from "node:assert/strict";
import test from "node:test";
import { UNKNOWN_POSITION, type LineMarker } from "@plurnk/plurnk-contracts";
import type { ResolvedEditStatement } from "@plurnk/plurnk-schemes";
import EditSequence from "./EditSequence.ts";
import LineAnchors from "../content/line-anchors.ts";
import LineMarkerOps from "../content/line-marker.ts";
import { editReceipt, projectEditReceipt, reviewerReplacementReceipt } from "../content/edit-receipt.ts";

const identity = "worker:///sequence.md";
const original = "one\ntwo\nthree\nfour\nfive\nsix\n";
const statement = (marker: LineMarker, body: string): ResolvedEditStatement => ({
    op: "EDIT", delimiter: "0", annotation: null, target: null, metadata: null,
    lineMarker: marker, body, position: UNKNOWN_POSITION,
});
const apply = (sequence: EditSequence, content: string, marker: LineMarker, body: string): string => {
    const snapshot = sequence.observe(identity, content);
    const update = LineMarkerOps.applyLineMarkerEdit(content, marker, body);
    assert.equal(update.status, 200);
    assert.ok(typeof update.result === "string");
    sequence.settle(snapshot, statement(marker, body), {
        status: 200,
        receipt: projectEditReceipt(editReceipt(content, update.result, [{ marker, body }]), 0),
    });
    return update.result;
};

for (const separator of ["\n", "\r\n", "\r"]) {
    for (const fixture of [
        { marks: [0], body: "prefix", oldLine: 1, newLine: 2 },
        { marks: [2], body: "", oldLine: 3, newLine: 2 },
        { marks: [2], body: "TWO\nextra", oldLine: 3, newLine: 4 },
        { marks: [2, 2, 2, 3], body: "😀", oldLine: 3, newLine: 3 },
        { marks: [3, 1, 3, 1], body: "before\n", oldLine: 3, newLine: 4 },
    ]) test(`{§edit-anchor-continuity}: ${JSON.stringify(separator)} <${fixture.marks}> preserves an untouched line`, () => {
        const source = original.replaceAll("\n", separator);
        const sequence = new EditSequence();
        const hash = LineAnchors.tokens(identity, source)[fixture.oldLine - 1]!;
        const updated = apply(sequence, source, { marks: fixture.marks as LineMarker["marks"] }, fixture.body.replaceAll("\n", separator));
        const snapshot = sequence.observe(identity, updated);
        assert.deepEqual(LineAnchors.resolve(LineAnchors.tokens(identity, updated), { marks: [hash] }, snapshot.anchors), {
            ok: true, marker: { marks: [fixture.newLine] },
        });
    });
}

test("{§edit-anchor-continuity}: replaced lines stay invalid while adjacent targets survive successive edits", () => {
    const sequence = new EditSequence();
    const hashes = LineAnchors.tokens(identity, original);
    const updated = apply(sequence, apply(sequence, original, { marks: [2] }, "TWO"), { marks: [0] }, "prefix");
    const snapshot = sequence.observe(identity, updated);
    const resolve = (hash: string) => LineAnchors.resolve(LineAnchors.tokens(identity, updated), { marks: [hash] }, snapshot.anchors);
    assert.deepEqual(resolve(hashes[1]!), { ok: false, failure: { kind: "missing", anchor: hashes[1] } });
    assert.deepEqual(resolve(hashes[2]!), { ok: true, marker: { marks: [4] } });
});

test("{§edit-anchor-continuity}: external drift and another program cannot reuse retained bindings", () => {
    const sequence = new EditSequence();
    const hash = LineAnchors.tokens(identity, original)[2]!;
    const updated = apply(sequence, original, { marks: [2] }, "TWO");
    const drifted = updated.replace("four", "FOUR");
    for (const snapshot of [sequence.observe(identity, drifted), new EditSequence().observe(identity, updated)]) {
        assert.deepEqual(LineAnchors.resolve(LineAnchors.tokens(identity, snapshot.content), { marks: [hash] }, snapshot.anchors), {
            ok: false, failure: { kind: "missing", anchor: hash },
        });
    }
});

test("{§edit-anchor-continuity}: an unproved or reviewer-replaced result cannot carry bindings", () => {
    for (const result of [
        { status: 200 },
        { status: 200, receipt: projectEditReceipt(reviewerReplacementReceipt(original, "reviewer replacement", editReceipt(original, "proposed", [{ marker: { marks: [1, -1] }, body: "proposed" }])), 0) },
        { status: 200, receipt: projectEditReceipt(editReceipt(original, original.replace("five", "FIVE"), [{ marker: { marks: [5] }, body: "FIVE" }]), 0) },
    ]) {
        const sequence = new EditSequence();
        const hash = LineAnchors.tokens(identity, original)[2]!;
        const updated = apply(sequence, original, { marks: [2] }, "TWO");
        sequence.settle(sequence.observe(identity, updated), statement({ marks: [5] }, "FIVE"), result);
        const snapshot = sequence.observe(identity, updated);
        assert.deepEqual(LineAnchors.resolve(LineAnchors.tokens(identity, updated), { marks: [hash] }, snapshot.anchors), {
            ok: false, failure: { kind: "missing", anchor: hash },
        });
    }
});

test("{§edit-anchor-continuity}: retained bindings never cross resource identities", () => {
    const sequence = new EditSequence();
    const hash = LineAnchors.tokens(identity, original)[2]!;
    const updated = apply(sequence, original, { marks: [2] }, "TWO");
    const other = "worker:///other.md";
    const snapshot = sequence.observe(other, updated);
    assert.deepEqual(LineAnchors.resolve(LineAnchors.tokens(other, updated), { marks: [hash] }, snapshot.anchors), {
        ok: false, failure: { kind: "missing", anchor: hash },
    });
});
