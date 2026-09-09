// The differential corpus: (grammar, input, expectation) cases, each justified by a
// real-world truth rather than by what the oracle happens to say (so it is a genuine
// test, not a tautology). Two grammar sources:
//
//   echo.gbnf   — a tiny hand-written grammar that pins the verdict trichotomy with
//                 oracle-independent certainty.
//   plurnk.*.gbnf — freshly serialized from plurnk-contracts' owning generator. These
//                   are the real situation the tooling exists for without copied snapshots.
//
// Shapes are drawn from the live ecosystem: Markdown operation sections,
// template-profile reasoning boundaries, terminal SEND
// status codes, and lane-aware section bodies (see plurnk-contracts' lexer and
// model reference).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildModel, serializeGbnf } from "../../../plurnk-contracts/scriptify/generate-gbnf.ts";
import type { Verdict } from "./_oracle.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string => join(here, "fixtures", name);

export const ECHO_GBNF = readFileSync(fixture("echo.gbnf"), "utf8");
export const PLURNK_GBNF = serializeGbnf(buildModel(), "root-gemma");
export const PLURNK_QWEN_GBNF = serializeGbnf(buildModel(), "root-qwen");

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
const CHANNEL = "<|channel>thought\nCheck the task.<channel|>\n";
const THINK_TAIL = "Check the task.</think>\n";
const REAL_PACKET =
    CHANNEL +
    "```PLAN\nFind and verify the answer.\n\n```" +
    "```FIND (known:///**)\n~capital of France\n\n```" +
    "```READ (plurnk:///manifest.json)\n$[?(@.channels.body)]\n\n```" +
    "```SEND\nParis\n```\n```TASK\n[{\"content\":\"Task completed.\",\"status\":\"completed\"}]\n```";

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
    { name: "plurnk/gemma-plan-read-send", grammar: PLURNK_GBNF,
      input: `${CHANNEL}\`\`\`PLAN
Read the greeting.
\`\`\`
\`\`\`READ (README.md)
$.greeting
\`\`\`
\`\`\`SEND
done
\`\`\`
\`\`\`TASK
[{"content":"Task completed.","status":"completed"}]
\`\`\``, expect: "accept",
      note: "a well-formed turn: Harmony channel + PLAN + statement + terminal SEND" },
    { name: "plurnk/qwen-plan-read-send", grammar: PLURNK_QWEN_GBNF,
      input: `${THINK_TAIL}\`\`\`PLAN
Read the greeting.
\`\`\`
\`\`\`READ (README.md)
$.greeting
\`\`\`
\`\`\`SEND
done
\`\`\`
\`\`\`TASK
[{"content":"Task completed.","status":"completed"}]
\`\`\``, expect: "accept",
      note: "the Qwen rail begins at sampled token zero after the template-provided opener" },
    { name: "plurnk/prose", grammar: PLURNK_GBNF, input: "Sure! The capital of France is Paris.",
      expect: "reject", pos: 0, note: "natural-language prose is not a plurnk turn" },
    { name: "plurnk/empty", grammar: PLURNK_GBNF, input: "", expect: "incomplete", pos: 0,
      note: "a turn needs at least the Harmony channel" },
    { name: "plurnk/channel-only", grammar: PLURNK_GBNF, input: CHANNEL, expect: "incomplete", pos: CHANNEL.length,
      note: "the channel alone is a prefix; PLAN and a terminal SEND are still expected" },
    { name: "plurnk/alternate-lane-literal", grammar: PLURNK_GBNF,
      input: `${CHANNEL}\`\`\`PLAN
Store the quoted section.
\`\`\`

\`\`\`EDIT (worker:///quoted.md)
quoted section:
### READ2 (README.md)
literal
\`\`\`

\`\`\`SEND
done
\`\`\`
\`\`\`TASK
[{"content":"Task completed.","status":"completed"}]
\`\`\``, expect: "reject",
      note: "the rail reserves every operation heading stem for lane `_`; ANTLR alone admits alternate-lane literals" },
    ...[
        { profile: "gemma", grammar: PLURNK_GBNF, prefix: CHANNEL },
        { profile: "qwen", grammar: PLURNK_QWEN_GBNF, prefix: THINK_TAIL },
    ].flatMap(({ profile, grammar, prefix }): Case[] => [
        { name: `plurnk/${profile}-inline-heading`, grammar,
          input: `${prefix}\`\`\`PLAN
Quote \`### READ_ (x)\`.
\`\`\`
\`\`\`SEND
Use \`## PLAN_\` and \`### SEND2 (TERM)\` as examples.
\`\`\`
\`\`\`TASK
[{"content":"Task completed.","status":"completed"}]
\`\`\``, expect: "accept",
          note: "inline quotations do not start new sections ({§rail-heading-boundaries})" },
        { name: `plurnk/${profile}-body-start-heading`, grammar,
          input: `${prefix}\`\`\`PLAN
### READ2 (x)
\`\`\`
\`\`\`SEND
Done.
\`\`\`
\`\`\`TASK
[{"content":"Task completed.","status":"completed"}]
\`\`\``, expect: "reject",
          note: "the first body line is a structural boundary too" },
        { name: `plurnk/${profile}-long-turn`, grammar,
          input: prefix + "```PLAN\nCurate.\n\n```" + "```KILL (log:///1/1/*/READ)```".repeat(24)
            + "```TASK\n[{\"content\":\"Continue.\\n\",\"status\":\"in_progress\"}]\n```" + "```READ (README.md)```".repeat(24), expect: "accept",
          note: "ordinary operations have no quota before or after disposition ({§gbnf-turn-shape})" },
        { name: `plurnk/${profile}-second-disposition`, grammar,
          input: `${prefix}### SEND_ (TERM)
Done.
\`\`\`KILL (log:///1/1/*/READ)\`\`\`
\`\`\`SEND
Again.
\`\`\`
\`\`\`TASK
[{"content":"Task completed.","status":"completed"}]
\`\`\``, expect: "reject",
          note: "post-disposition work cannot introduce a second disposition" },
    ]),
];
