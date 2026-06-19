// The differential engine. A Validator answers a (grammar, input) pair with a Verdict;
// the harness asserts every registered validator agrees both with the labeled corpus
// expectation and with every other validator.
//
// Today the registry holds only the compiled C oracle, so the cross-check reduces to
// "the oracle matches the corpus." The moment the native TS GBNF engine is registered
// here, the SAME corpus becomes a true TS-vs-oracle differential with no new test code.
// That is the whole point of the oracle's existence (AGENTS.md §9, §10).

import { readFileSync } from "node:fs";
import { runOracle, type Verdict } from "./_oracle.ts";
import { validateGbnf } from "../../src/index.ts";

export type Validator = {
    name: string;
    validate: (grammarPath: string, input: string) => Verdict;
};

export const VALIDATORS: Validator[] = [
    { name: "oracle", validate: runOracle },
    { name: "ts", validate: (grammarPath, input) => validateGbnf(readFileSync(grammarPath, "utf8"), input) },
];

export const sameVerdict = (a: Verdict, b: Verdict): boolean => {
    if (a.status !== b.status) return false;
    if (a.status === "reject" && b.status === "reject") return a.pos === b.pos && a.char === b.char;
    if (a.status === "incomplete" && b.status === "incomplete") return a.pos === b.pos;
    return true;
};

export const describe = (v: Verdict): string =>
    v.status === "accept"
        ? "accept"
        : v.status === "incomplete"
          ? `incomplete@${v.pos}`
          : `reject@${v.pos}('${v.char}')`;
