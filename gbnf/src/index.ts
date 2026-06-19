// Public API. validateGbnf is the native, zero-dependency port of llama.cpp's GBNF
// validator: it parses a grammar, runs an input's code points through the matcher, and
// returns the same tri-state verdict the C oracle does (accept / incomplete / reject).

import GbnfParser from "./GbnfParser.ts";
import GbnfMatcher from "./GbnfMatcher.ts";
import type { Verdict } from "./types.ts";

export const validateGbnf = (grammar: string, input: string, root = "root"): Verdict => {
    const parser = GbnfParser.parse(grammar);
    if (!parser.ok || parser.rules.length === 0) throw new Error("failed to parse grammar");

    const matcher = GbnfMatcher.init(parser.rules, parser.symbolIds, root);
    if (!matcher) throw new Error(`grammar has no '${root}' symbol, or is left-recursive`);

    const cpts = [...input].map((ch) => ch.codePointAt(0)!);
    for (let i = 0; i < cpts.length; i++) {
        matcher.accept(cpts[i]);
        if (matcher.stacks.length === 0) return { status: "reject", pos: i, char: String.fromCodePoint(cpts[i]) };
    }
    if (matcher.stacks.some((s) => s.length === 0)) return { status: "accept" };
    return { status: "incomplete", pos: cpts.length };
};

export { default as GbnfParser } from "./GbnfParser.ts";
export { default as GbnfMatcher } from "./GbnfMatcher.ts";
export { GRETYPE } from "./types.ts";
export type { Verdict, GrammarElement, GrammarRule, StackRef, Stack } from "./types.ts";
