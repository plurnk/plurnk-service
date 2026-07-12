// THE experiment: reason freely in the thought channel, then constrain content
// to valid DSL — via /completion (which honors lazy grammar) + a trigger on
// gemma's thinking-close marker <channel|>. If this works, strict+reasoning
// coexist, killing the "grammar nukes the side channel" problem.
import { readFileSync } from "node:fs";
const BASE = "http://127.0.0.1:11435";
const G = "/home/hyzen/repo/plurnk/plurnk-service/node_modules/@plurnk/plurnk-grammar";
const system = readFileSync(`${G}/plurnk.md`, "utf8");
const strict = readFileSync(`${G}/dist/plurnk-strict.gbnf`, "utf8");

const PROMPT = "Reason step-by-step. Puzzle: all Bloops are Razzies; all Razzies are Lazzies; no Lazzies are Moops. Can a Bloop be a Moop? Deliver just 'yes' or 'no' with a SEND.";

// 1. Get the templated prompt (with enable_thinking) from the server itself.
const tmpl = await (await fetch(`${BASE}/apply-template`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
        messages: [{ role: "system", content: system }, { role: "user", content: PROMPT }],
        chat_template_kwargs: { enable_thinking: true },
    }),
})).json();
const prompt = tmpl.prompt;
console.log(`templated prompt: ${prompt.length} chars; tail: ${JSON.stringify(prompt.slice(-80))}\n`);

const complete = async (label, extra) => {
    const res = await fetch(`${BASE}/completion`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, n_predict: 1500, temperature: 0, id_slot: 0, repeat_penalty: 1.15, ...extra }),
        signal: AbortSignal.timeout(180_000),
    });
    const j = await res.json();
    const c = j.content ?? "";
    // split on the thinking-close marker: everything before is "reasoning", after is "content"
    const close = c.indexOf("<channel|>");
    const reason = close >= 0 ? c.slice(0, close) : "";
    const after = close >= 0 ? c.slice(close + "<channel|>".length) : c;
    console.log(`${label}:`);
    console.log(`   reason(pre-close)=${reason.length}B  content(post-close)=${after.length}B  tok/s=${Math.round(j.timings?.predicted_per_second ?? 0)}  stop=${j.stop_type}`);
    console.log(`   reason head : ${JSON.stringify(reason.replace(/^[\s\S]*?<\|channel>thought/, "").slice(0, 80))}`);
    console.log(`   content     : ${JSON.stringify(after.slice(0, 90))}`);
};

await complete("eager strict (no lazy)            ", { grammar: strict });
await complete("LAZY strict + <channel|> trigger  ", { grammar: strict, grammar_lazy: true, grammar_triggers: [{ type: "word", value: "<channel|>" }] });
