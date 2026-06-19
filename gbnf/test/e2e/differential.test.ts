// e2e differential tests. Assumes build/llama-gbnf is compiled (Charter §8):
//   npm run build:llama && npm run test:e2e

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { ORACLE } from "./_oracle.ts";
import { CORPUS } from "./_corpus.ts";
import { VALIDATORS, sameVerdict, describe } from "./_harness.ts";

test("the oracle binary is compiled", () => {
    assert.ok(
        existsSync(ORACLE),
        `oracle missing at ${ORACLE} — run \`npm run build:llama\` first (Charter §8)`,
    );
});

// 1) Correctness: every validator matches the real-world-justified expectation for
//    every corpus case.
for (const c of CORPUS) {
    for (const v of VALIDATORS) {
        test(`${v.name} :: ${c.name} — ${c.note}`, () => {
            const got = v.validate(c.grammar, c.input);
            assert.equal(got.status, c.expect, `expected ${c.expect}, got ${describe(got)}`);
            if (c.pos !== undefined && got.status !== "accept")
                assert.equal(got.pos, c.pos, `position mismatch: got ${describe(got)}`);
        });
    }
}

// 2) Differential: all registered validators agree, character-position included.
//    A tautology with one validator; a real TS-vs-oracle cross-check once a second
//    engine is registered. Surfaced explicitly so the single-validator state is never
//    a silent pass.
test("differential: every validator agrees on every corpus case", () => {
    if (VALIDATORS.length < 2) {
        assert.equal(VALIDATORS[0]?.name, "oracle", "the oracle must be the reference validator");
        return;
    }
    const disagreements: string[] = [];
    for (const c of CORPUS) {
        const [ref, ...rest] = VALIDATORS.map((v) => ({ name: v.name, verdict: v.validate(c.grammar, c.input) }));
        for (const other of rest)
            if (!sameVerdict(ref.verdict, other.verdict))
                disagreements.push(
                    `${c.name}: ${ref.name}=${describe(ref.verdict)} vs ${other.name}=${describe(other.verdict)}`,
                );
    }
    assert.equal(disagreements.length, 0, `validator disagreement:\n${disagreements.join("\n")}`);
});
