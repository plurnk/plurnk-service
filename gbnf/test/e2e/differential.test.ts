// e2e differential tests. Assumes build/llama-gbnf is compiled (Charter §8):
//   npm run oracle:build && npm run test:llama

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { ORACLE } from "./_oracle.ts";
import { CORPUS } from "./_corpus.ts";
import { VALIDATORS, sameVerdict, describe } from "./_harness.ts";

test("the oracle binary is compiled", () => {
    assert.ok(
        existsSync(ORACLE),
        `oracle missing at ${ORACLE} — run \`npm run oracle:build\` first (Charter §8)`,
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
test("differential: every validator agrees on every corpus case", () => {
    assert.equal(VALIDATORS[0]?.name, "oracle", "the oracle must be the reference validator");
    assert.ok(VALIDATORS.length >= 2, "differential coverage requires a second validator");
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
