// The differential corpus: (grammar, input, expectation) cases, each justified by a
// real-world truth rather than by what the oracle happens to say (so it is a genuine
// test, not a tautology). Two grammar fixtures:
//
//   echo.gbnf   — a tiny hand-written grammar that pins the verdict trichotomy with
//                 oracle-independent certainty.
//   plurnk.gbnf — a verbatim snapshot of plurnk-contracts/dist/plurnk.gbnf, the actual
//                 generated grammar that constrains the live model. This is the real
//                 situation the tooling exists for; refresh it from the sibling repo.
//
// Shapes are drawn from the live ecosystem: the FIND/READ/SEND enclosure form, the
// Harmony reasoning channel that the grammar's root requires, terminal
// SEND status codes, and the complement-automaton bodies that swallow text until a
// matching close tag (see plurnk-contracts' plurnkLexer.g4 and plurnk.md).

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

// Representative current GBNF-constrained output spanning PLAN, matcher bodies,
// retrieval, and terminal SEND under the required reasoning enclosure.
const CHANNEL = "<|channel>thought\n<channel|>\n";
const REAL_PACKET =
    CHANNEL +
    "<|PLAN>Find and verify the answer.<PLAN|>\n" +
    "<|FIND(known:///**)>~capital of France<FIND|>\n" +
    "<|READ(plurnk:///manifest.json)>$[?(@.channels.body)]<READ|>\n" +
    "<|SEND[200]>Paris<SEND|>";

export const CORPUS: Case[] = [
    // ---- controlled grammar: the verdict trichotomy, oracle-independent ----
    { name: "echo/complete", grammar: ECHO_GBNF, input: "<|ECHO>hi<ECHO|>", expect: "accept",
      note: "a well-formed sentence in the grammar" },
    { name: "echo/empty-body", grammar: ECHO_GBNF, input: "<|ECHO><ECHO|>", expect: "accept",
      note: "[a-z]* admits the empty body" },
    { name: "echo/truncated", grammar: ECHO_GBNF, input: "<|ECHO>hi", expect: "incomplete", pos: 9,
      note: "valid prefix; the '<ECHO|>' close tag never arrives" },
    { name: "echo/bad-char", grammar: ECHO_GBNF, input: "<|ECHO>Hi<ECHO|>", expect: "reject", pos: 7,
      note: "uppercase 'H' is outside [a-z]" },
    { name: "echo/junk", grammar: ECHO_GBNF, input: "oops", expect: "reject", pos: 0,
      note: "no '<|ECHO>' opener at all" },

    // ---- the real generated grammar against real-world shapes ----
    { name: "plurnk/representative-turn", grammar: PLURNK_GBNF, input: REAL_PACKET, expect: "accept",
      note: "the current rail must admit its representative full turn" },
    { name: "plurnk/channel-plan-read-send", grammar: PLURNK_GBNF,
      input: `${CHANNEL}<|PLAN>Read the greeting.<PLAN|>\n<|READ(README.md)>$.greeting<READ|>\n<|SEND[200]>done<SEND|>`, expect: "accept",
      note: "a well-formed turn: Harmony channel + PLAN + statement + terminal SEND" },
    { name: "plurnk/prose", grammar: PLURNK_GBNF, input: "Sure! The capital of France is Paris.",
      expect: "reject", pos: 0, note: "natural-language prose is not a plurnk turn" },
    { name: "plurnk/empty", grammar: PLURNK_GBNF, input: "", expect: "incomplete", pos: 0,
      note: "a turn needs at least the Harmony channel" },
    { name: "plurnk/channel-only", grammar: PLURNK_GBNF, input: CHANNEL, expect: "incomplete", pos: CHANNEL.length,
      note: "the channel alone is a prefix; PLAN and a terminal SEND are still expected" },
    { name: "plurnk/mismatched-close", grammar: PLURNK_GBNF,
      input: `${CHANNEL}<|PLAN>Search first.<PLAN|>\n<|FIND(known:///**)>~x<READ|>`, expect: "incomplete",
      note: "the FIND body absorbs '<READ|>' as content; the matching '<FIND|>' never arrives" },
];
