import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classify, CORPUS, localIdentifiers, type CorpusRecord } from "../../scriptify/extract-emission-corpus.ts";

describe("recorded-emissions", () => {
const records: CorpusRecord[] = readFileSync(CORPUS, "utf8")
    .split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as CorpusRecord);

test("{§whitespace-contract}: every recorded emission still parses, and to the same shape", () => {
    assert.ok(records.length >= 100, `the corpus holds ${records.length} shapes; it should not shrink silently`);
    const moved: string[] = [];
    for (const record of records) {
        const now = classify(record.emission);
        if (JSON.stringify(now.ops) !== JSON.stringify(record.ops)
            || now.outsideText !== record.outsideText
            || JSON.stringify(now.errors) !== JSON.stringify(record.errors)) {
            const was = { ops: record.ops, outsideText: record.outsideText, errors: record.errors };
            moved.push(`${record.specimen}/${record.packet} (${record.turns} recorded turns)`
                + `: was ${JSON.stringify(was)}, now ${JSON.stringify(now)}`);
        }
    }
    assert.deepEqual(moved, [], "a shape moved: re-run the extractor and review what the contract now does differently");
});

test("{§whitespace-contract}: no recorded emission throws", () => {
    // A real model produced each of these. The parser owes every one of them an answer
    // under {§whitespace-contract} — a diagnostic, not a crash.
    for (const { specimen, packet, emission } of records) {
        assert.doesNotThrow(() => classify(emission), `${specimen}/${packet}`);
    }
});

test("{§whitespace-contract}: the corpus spans the contract, not one corner of it", () => {
    const ops = new Set(records.flatMap(({ ops: o }) => o));
    for (const op of ["READ", "FIND", "EDIT", "SEND", "KILL", "NOTE", "WAIT", "WORK"]) {
        assert.ok(ops.has(op), `no recorded emission authored ${op}; the corpus has a blind spot`);
    }
    assert.ok(records.some(({ outsideText }) => outsideText), "no outside text");
    assert.ok(records.some(({ errors }) => errors.length > 0), "no parser refusals: the corpus holds only valid programs");
    assert.ok(records.some(({ recordedStatus, errors }) => recordedStatus === 200 && errors.length > 0),
        "no historic success that is refused by the current grammar");
});

test("{§whitespace-contract}: the corpus carries no identifier of the machine that recorded or runs it", () => {
    const leaked = records.flatMap((record) => localIdentifiers()
        .filter(([pattern]) => new RegExp(pattern.source, pattern.flags.replace("g", "")).test(`${record.specimen}\n${record.emission}`))
        .map(([pattern]) => `${record.specimen}/${record.packet}: ${pattern.source}`));
    assert.deepEqual(leaked, []);
});
});
