// Mechanism diagnostic: is lazy grammar HONORED on this build, and does it
// suspend the constraint during the thought channel? Tool-forbidden logic
// puzzle forces prose reasoning so reason_chars is a clean signal.
import { readFileSync } from "node:fs";
const BASE = "http://127.0.0.1:11435";
const G = "/home/hyzen/repo/plurnk/plurnk-service/node_modules/@plurnk/plurnk-grammar";
const system = readFileSync(`${G}/plurnk.md`, "utf8");
const strict = readFileSync(`${G}/dist/plurnk-strict.gbnf`, "utf8");

const PROMPT = "Reason step-by-step IN PROSE. Do NOT use EXEC or any tool. Puzzle: all Bloops are Razzies; all Razzies are Lazzies; no Lazzies are Moops. Can a Bloop be a Moop? Then deliver just 'yes' or 'no' with a SEND.";

const run = async (label, extra) => {
    const body = {
        messages: [{ role: "system", content: system }, { role: "user", content: PROMPT }],
        max_tokens: 1200, temperature: 0, id_slot: 0,
        chat_template_kwargs: { enable_thinking: true }, repeat_penalty: 1.15, ...extra,
    };
    const res = await fetch(`${BASE}/v1/chat/completions`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(120_000),
    });
    const j = await res.json();
    if (j.error) { console.log(`${label}: ERROR ${JSON.stringify(j.error).slice(0, 100)}`); return; }
    const m = j.choices[0].message;
    const content = m.content ?? "";
    const constrained = content.trimStart().startsWith("<<"); // strict forces this
    console.log(`${label}: reason=${(m.reasoning_content ?? "").length}B content=${content.length}B startsWith<<=${constrained} finish=${j.choices[0].finish_reason}`);
    console.log(`   content: ${JSON.stringify(content.slice(0, 80))}`);
};

await run("A no-grammar (baseline reasoning?)   ", {});
await run("B eager strict                       ", { grammar: strict });
await run("C lazy strict + NEVER-trigger        ", { grammar: strict, grammar_lazy: true, grammar_triggers: [{ type: "word", value: "ZZZNEVERFIRES" }] });
await run("D lazy strict + <channel|> close     ", { grammar: strict, grammar_lazy: true, grammar_triggers: [{ type: "word", value: "<channel|>" }] });
