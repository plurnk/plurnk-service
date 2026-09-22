// {§recorded-emissions} — the corpus is every distinct parse shape 2,170 real model turns
// produced across the live and demo drills, one exemplar each. These are the only inputs in
// the suite nobody authored to pass a test: a fixture encodes what we believe a model emits,
// a recording encodes what one did. Both #802 and #809 shipped regressions through a green
// suite because every fixture in it was ours.
//
// Regenerate with `node --conditions=plurnk-dev scriptify/extract-emission-corpus.ts --write`
// after a drill. A change here is never a failure to paper over: it is the contract moving,
// and the diff names every shape that moved with it.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { classify, CORPUS, type CorpusRecord } from "../../scriptify/extract-emission-corpus.ts";

const records: CorpusRecord[] = readFileSync(CORPUS, "utf8")
    .split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as CorpusRecord);

test("{§recorded-emissions}: every recorded emission still parses, and to the same shape", () => {
    assert.ok(records.length >= 100, `the corpus holds ${records.length} shapes; it should not shrink silently`);
    const moved: string[] = [];
    for (const record of records) {
        const now = classify(record.emission);
        if (JSON.stringify(now.ops) !== JSON.stringify(record.ops)
            || now.outsideText !== record.outsideText
            || now.bareKills !== record.bareKills) {
            const was = { ops: record.ops, outsideText: record.outsideText, bareKills: record.bareKills };
            moved.push(`${record.specimen}/${record.packet} (${record.turns} recorded turns)`
                + `: was ${JSON.stringify(was)}, now ${JSON.stringify(now)}`);
        }
    }
    assert.deepEqual(moved, [], "a shape moved: re-run the extractor and review what the contract now does differently");
});

test("{§recorded-emissions}: no recorded emission throws", () => {
    // A real model produced each of these. The parser owes every one of them an answer
    // under {§turn-shape} — a diagnostic, not a crash.
    for (const { specimen, packet, emission } of records) {
        assert.doesNotThrow(() => classify(emission), `${specimen}/${packet}`);
    }
});

test("{§recorded-emissions}: the corpus spans the contract, not one corner of it", () => {
    const ops = new Set(records.flatMap(({ ops: o }) => o));
    for (const op of ["READ", "FIND", "EDIT", "SEND", "KILL", "NOTE", "WAIT", "WORK"]) {
        assert.ok(ops.has(op), `no recorded emission authored ${op}; the corpus has a blind spot`);
    }
    assert.ok(records.some(({ outsideText }) => outsideText), "no recovered outside text");
    assert.ok(records.some(({ bareKills }) => bareKills > 0), "no parameterless KILL: the conclusion path is uncovered");
    assert.ok(records.some(({ recordedStatus, bareKills }) => recordedStatus === 200 && bareKills === 0),
        "no pre-KILL conclusion retained: the corpus has forgotten that the contract used to differ");
});
