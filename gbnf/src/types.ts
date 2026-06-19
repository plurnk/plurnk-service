// GBNF grammar element types, mirroring `enum llama_gretype` in
// llama/src/llama-grammar.h. The TS engine is a faithful port of that C engine, so
// these values are load-bearing — they must match upstream exactly.
export const GRETYPE = Object.freeze({
    END: 0,
    ALT: 1,
    RULE_REF: 2,
    CHAR: 3,
    CHAR_NOT: 4,
    CHAR_RNG_UPPER: 5,
    CHAR_ALT: 6,
    CHAR_ANY: 7,
    TOKEN: 8,
    TOKEN_NOT: 9,
});

export type GrammarElement = { type: number; value: number };
export type GrammarRule = GrammarElement[];

// A position into the rule table: rules[rule][pos] is the active element. The C engine
// uses raw element pointers; the port uses (rule, pos) index pairs.
export type StackRef = { rule: number; pos: number };
export type Stack = StackRef[];

// Tri-state outcome, identical in shape to the oracle's verdict (see test/e2e/_oracle.ts):
//   accept     — the whole input is a complete sentence
//   incomplete — a valid prefix; EOF arrived before any stack could close
//   reject     — a code point at `pos` cannot extend any stack
export type Verdict =
    | { status: "accept" }
    | { status: "incomplete"; pos: number }
    | { status: "reject"; pos: number; char: string };
