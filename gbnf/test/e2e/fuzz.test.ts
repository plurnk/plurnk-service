// Fuzz differential: the strongest faithfulness check. Random and plurnk-shaped inputs
// are run through every validator; the oracle is ground truth, so no pre-labeled
// expectation is needed — TS must simply agree with llama.cpp, character position
// included. Seeded (deterministic) so any divergence reproduces exactly.

import test from "node:test";
import assert from "node:assert/strict";
import { PLURNK_GBNF, ECHO_GBNF } from "./_corpus.ts";
import { VALIDATORS, sameVerdict, describe } from "./_harness.ts";

// mulberry32 — a tiny deterministic PRNG (no Math.random, so runs are reproducible).
const rng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// plurnk-flavoured fragments — assembling these provokes deep traversal of the real
// grammar (section headings, targets, matchers, signals, and nesting lanes),
// landing on a rich mix of accept / incomplete / reject verdicts.
const FRAGMENTS = [
    "<|channel>thought\n", "<channel|>", "\n", "\n\n", " ", "\t",
    "# PLAN1", "# PLAN2", "## FIND1", "## READ1", "## EDIT1", "## SEND1", "## EXEC1",
    "## COPY1", "## MOVE1", "## OPEN1", "## FOLD1", "## KILL1", "## EDIT2", " ## FIND1", "",
    "(known:///**)", "(plurnk:///manifest.json)", "(README.md)", "(run://x)", "(#re#i)", "()",
    "[200]", "[philosophy,france]", "[]",
    "<1,2>", "<0.7>", "<-1>", "<2.5>",
    ":", "~capital of France", "$.greeting", "$[?(@.x)]", "//h2/text()", "@<sym", "revolution", "Paris",
    "%28", "%29",
];

const PRINTABLE = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 <>[](){}:;~$#@/.,-_|*+?!\"'\n\t";
const MULTIBYTE = ["é", "ñ", "λ", "你", "🙂", "—", " "];

const pick = <T>(r: () => number, xs: T[]): T => xs[Math.floor(r() * xs.length)];

const genStructured = (r: () => number): string => {
    const n = 1 + Math.floor(r() * 12);
    let s = r() < 0.7 ? "<|channel>thought\n<channel|>\n" : "";
    for (let i = 0; i < n; i++) s += pick(r, FRAGMENTS);
    if (r() < 0.3) s = s.slice(0, Math.floor(r() * (s.length + 1))); // truncate to a prefix
    return s;
};

const genNoise = (r: () => number): string => {
    const n = Math.floor(r() * 24);
    let s = "";
    for (let i = 0; i < n; i++) s += PRINTABLE[Math.floor(r() * PRINTABLE.length)];
    return s;
};

const genMultibyte = (r: () => number): string => {
    let s = "<|channel>thought\n<channel|>\n# PLAN1\nanswer\n\n## SEND1 [200]\n";
    const n = Math.floor(r() * 6);
    for (let i = 0; i < n; i++) s += r() < 0.5 ? pick(r, MULTIBYTE) : PRINTABLE[Math.floor(r() * PRINTABLE.length)];
    return s;
};

const fuzzCase = (grammar: string, input: string): string | null => {
    const verdicts = VALIDATORS.map((v) => ({ name: v.name, verdict: v.validate(grammar, input) }));
    const [ref, ...rest] = verdicts;
    for (const other of rest)
        if (!sameVerdict(ref.verdict, other.verdict))
            return `input=${JSON.stringify(input)}\n  ${ref.name}=${describe(ref.verdict)} vs ${other.name}=${describe(other.verdict)}`;
    return null;
};

test("fuzz differential: TS matches the oracle on random + plurnk-shaped inputs", () => {
    if (VALIDATORS.length < 2) return; // nothing to differentiate yet
    const r = rng(0x9e3779b9);
    const disagreements: string[] = [];
    const plan: Array<[string, (g: () => number) => string]> = [
        ...Array<[string, (g: () => number) => string]>(200).fill([PLURNK_GBNF, genStructured]),
        ...Array<[string, (g: () => number) => string]>(40).fill([PLURNK_GBNF, genNoise]),
        ...Array<[string, (g: () => number) => string]>(30).fill([PLURNK_GBNF, genMultibyte]),
        ...Array<[string, (g: () => number) => string]>(40).fill([ECHO_GBNF, genNoise]),
    ];
    for (const [grammar, gen] of plan) {
        const bad = fuzzCase(grammar, gen(r));
        if (bad) disagreements.push(bad);
    }
    assert.equal(
        disagreements.length,
        0,
        `${disagreements.length}/${plan.length} fuzz cases disagree:\n${disagreements.slice(0, 8).join("\n")}`,
    );
});
