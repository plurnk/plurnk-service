// Can we make the grammar apply to the CONTENT channel only, not the thought
// channel? gemma delimits thinking with <|channel>thought ... <channel|>.
// A lazy grammar triggered on the close marker should let reasoning flow free,
// then constrain. Tries several trigger forms (the API has shifted across builds).
import { readFileSync } from "node:fs";
const BASE = "http://127.0.0.1:11435";
const G = "/home/hyzen/repo/plurnk/plurnk-service/node_modules/@plurnk/plurnk-grammar";
const system = readFileSync(`${G}/plurnk.md`, "utf8");
const strict = readFileSync(`${G}/dist/plurnk-strict.gbnf`, "utf8");

// a task that actually needs multi-step reasoning (gemma may slip without it)
const PROMPT = "A shed has 3 boxes. Each box holds 4 jars. Each jar holds 7 marbles, but 5 marbles are cracked and removed from the total. How many good marbles are there? Deliver ONLY the final number with a SEND.";
const ANSWER = "79"; // 3*4*7=84, -5 = 79

const run = async (label, extra) => {
    const body = {
        messages: [{ role: "system", content: system }, { role: "user", content: PROMPT }],
        max_tokens: 1200, temperature: 0, id_slot: 0,
        chat_template_kwargs: { enable_thinking: true },
        repeat_penalty: 1.15,
        ...extra,
    };
    const t0 = Date.now();
    try {
        const res = await fetch(`${BASE}/v1/chat/completions`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body), signal: AbortSignal.timeout(120_000),
        });
        const j = await res.json();
        if (j.error) { console.log(`${label}: ERROR ${JSON.stringify(j.error).slice(0, 120)}`); return; }
        const m = j.choices[0].message;
        const reason = (m.reasoning_content ?? "").length;
        const content = m.content ?? "";
        console.log(`${label}: ${Date.now() - t0}ms reason=${reason}B content=${content.length}B finish=${j.choices[0].finish_reason} correct=${content.includes(ANSWER)}`);
        console.log(`   reason head: ${JSON.stringify((m.reasoning_content ?? "").slice(0, 70))}`);
        console.log(`   content    : ${JSON.stringify(content.slice(0, 90))}`);
    } catch (e) { console.log(`${label}: ${e.name}`); }
};

// Baseline: eager strict (the known-broken case — expect reason=0)
await run("eager strict             ", { grammar: strict });
// Lazy + close-marker trigger, several API forms:
await run("lazy + word <channel|>   ", { grammar: strict, grammar_lazy: true, grammar_triggers: [{ type: "word", value: "<channel|>" }] });
await run("lazy + pattern close     ", { grammar: strict, grammar_lazy: true, grammar_triggers: [{ type: "pattern", value: "<channel\\|>" }] });
await run("lazy + numeric-type 1    ", { grammar: strict, grammar_lazy: true, grammar_triggers: [{ type: 1, value: "<channel|>" }] });
