// The differential engine. A Validator answers a (grammar, input) pair with a Verdict;
// the harness asserts every registered validator agrees both with the labeled corpus
// expectation and with every other validator.
//
// The registry holds the compiled C oracle and the native TS GBNF engine, so every
// case is both independently labeled and checked across implementations.

import { runOracle, type Verdict } from "./_oracle.ts";
import { validateGbnf } from "../../src/index.ts";

export type Validator = {
    name: string;
    validate: (grammar: string, input: string) => Verdict;
};

export const VALIDATORS: Validator[] = [
    { name: "oracle", validate: runOracle },
    { name: "ts", validate: validateGbnf },
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
