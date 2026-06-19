// The differential corpus: (grammar, input, expectation) cases, each justified by a
// real-world truth rather than by what the oracle happens to say (so it is a genuine
// test, not a tautology). Two grammar fixtures:
//
//   echo.gbnf   — a tiny hand-written grammar that pins the verdict trichotomy with
//                 oracle-independent certainty.
//   plurnk.gbnf — a verbatim snapshot of plurnk-grammar/dist/plurnk.gbnf, the actual
//                 generated grammar that constrains the live model. This is the real
//                 situation the tooling exists for; refresh it from the sibling repo.
//
// Shapes are drawn from the live ecosystem: the FIND/READ/SEND heredoc form, the
// `<think>…</think>` reasoning preamble that the grammar's root requires, terminal
// SEND status codes, and the complement-automaton bodies that swallow text until a
// matching close tag (see plurnk-grammar's plurnkLexer.g4 and plurnk.md).

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Verdict } from "./_oracle.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string => join(here, "fixtures", name);

export const ECHO_GBNF = fixture("echo.gbnf");
export const PLURNK_GBNF = fixture("plurnk.gbnf");

export type Case = {
    name: string;
    grammar: string;
    input: string;
    expect: Verdict["status"];
    pos?: number; // when set, reject/incomplete position must match exactly
    note: string; // why this expectation is true independent of the oracle
};

// Real GBNF-constrained model output, verbatim from
// plurnk-service/test/digest/packet001.assistant.md. The model emitted it UNDER this
// exact grammar, so the grammar is obliged to accept it.
const REAL_PACKET =
    "<think>\n</think>\n\n" +
    "<<FIND(known:///**):~capital of France:FIND\n" +
    "<<READ(plurnk:///manifest.json):$[?(@.channels.body)]:READ\n" +
    "<<SEND[200]:Paris:SEND";

export const CORPUS: Case[] = [
    // ---- controlled grammar: the verdict trichotomy, oracle-independent ----
    { name: "echo/complete", grammar: ECHO_GBNF, input: "<<ECHO:hi:ECHO", expect: "accept",
      note: "a well-formed sentence in the grammar" },
    { name: "echo/empty-body", grammar: ECHO_GBNF, input: "<<ECHO::ECHO", expect: "accept",
      note: "[a-z]* admits the empty body" },
    { name: "echo/truncated", grammar: ECHO_GBNF, input: "<<ECHO:hi", expect: "incomplete", pos: 9,
      note: "valid prefix; the ':ECHO' close tag never arrives" },
    { name: "echo/bad-char", grammar: ECHO_GBNF, input: "<<ECHO:Hi:ECHO", expect: "reject", pos: 7,
      note: "uppercase 'H' is outside [a-z]" },
    { name: "echo/junk", grammar: ECHO_GBNF, input: "oops", expect: "reject", pos: 0,
      note: "no '<<ECHO:' opener at all" },

    // ---- the real generated grammar against real-world shapes ----
    { name: "plurnk/real-packet", grammar: PLURNK_GBNF, input: REAL_PACKET, expect: "accept",
      note: "the live model emitted this verbatim under this grammar" },
    { name: "plurnk/think-read-send", grammar: PLURNK_GBNF,
      input: "<think>\n</think>\n\n<<READ(README.md):$.greeting:READ\n<<SEND[200]:done:SEND", expect: "accept",
      note: "a well-formed turn: think preamble + statement + terminal SEND" },
    { name: "plurnk/prose", grammar: PLURNK_GBNF, input: "Sure! The capital of France is Paris.",
      expect: "reject", pos: 0, note: "natural-language prose is not a plurnk turn" },
    { name: "plurnk/empty", grammar: PLURNK_GBNF, input: "", expect: "incomplete", pos: 0,
      note: "a turn needs at least the think preamble" },
    { name: "plurnk/think-only", grammar: PLURNK_GBNF, input: "<think>\n</think>\n\n", expect: "incomplete", pos: 18,
      note: "the preamble alone is a prefix; statements are still expected" },
    { name: "plurnk/mismatched-close", grammar: PLURNK_GBNF,
      input: "<think>\n</think>\n\n<<FIND(known:///**):~x:READ", expect: "incomplete",
      note: "the FIND body absorbs ':READ' as content; the matching ':FIND' never arrives" },
];
