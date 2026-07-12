// Deterministically compose the candidate grammar from the shipped plurnk.gbnf:
//   root ::= <think>?…</think> → (mid-op sep)* → terminal SEND
// <think> is OPTIONAL and the ONLY non-op content allowed before ops, so the
// same grammar serves reasoning models (fill it) and non-reasoning ones (skip
// it). No op cap (clean terminal SEND is the gate). No PLAN mandate; plan-1..9
// dropped (plain inert plan kept). Reuses every op rule; swaps only the root.
import { readFile, writeFile } from "node:fs/promises";
const SRC = "/home/hyzen/repo/plurnk/plurnk-grammar/dist/plurnk.gbnf";
const OUTS = [
    "/home/hyzen/repo/plurnk/plurnk-grammar/plurnk-think.gbnf", // delivery (backend-agnostic name)
    "/home/hyzen/repo/plurnk/plurnk-service/plurnk-deepfire.gbnf", // keep fireflash config working
];

let g = await readFile(SRC, "utf8");
g = g.replace(/^root ::= root-plan$/m, [
    "root ::= think? sep batch-step* send-final-any sep",
    'think ::= "<think>" thinkbody "</think>"',
    'thinkbody ::= ([^<] | "<" [^/])*',
].join("\n"));
g = g.replace(/ \| plan-1 \| plan-2 \| plan-3 \| plan-4 \| plan-5 \| plan-6 \| plan-7 \| plan-8 \| plan-9/g, "");
for (const out of OUTS) await writeFile(out, g);

const opLine = g.split("\n").find((l) => l.startsWith("op-statement ::="));
console.log(`written ${g.length} bytes to:\n  ${OUTS.join("\n  ")}`);
console.log("root   :", g.split("\n").find((l) => l.startsWith("root ::=")));
console.log("think? optional, only pre-op content:", g.includes("root ::= think? sep"));
console.log("op-statement keeps plain plan, drops plan-1:", /\| plan(?:$| )/.test(opLine) && !opLine.includes("plan-1"));
