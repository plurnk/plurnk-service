// Paired cross-backend tuning sweep. Runs the SAME
// REAL packet (plurnk-service test/digest packet001) + the REAL plurnk.gbnf
// through BOTH backends, varying only decode knobs, and grades objectively:
// conformance (@plurnk/gbnf verdict on content), termination (finish=stop),
// wall-clock, completion tokens, reasoning-channel bytes.
//
// Direct transport calls (NOT the provider) so each knob varies independently;
// the shipped provider path gets a confirmation pass after the matrix picks
// winners. Needs: local llama-server (PLURNK_LLAMA_URL, default :11435),
// FIREWORKS_API_KEY, and plurnk-service installed (grammar + packet artifacts).
//
//   node bench/paired-tuning-sweep.mjs
//
// Axes (small on purpose — decision data, not an exhaustive grid):
//   gemma:     grammarMode {ingrammar, lazy-trigger} × thinking {on, off} × cap {1024, 4096}
//   fireworks: reasoning_effort {none, high} × cap {1024, 4096}
// Constants: temperature 0.2, repeat/repetition penalty 1.15 (the shipped grammar floor).

import { readFileSync } from "node:fs";
import { validateGbnf } from "/home/hyzen/repo/plurnk/plurnk-providers/node_modules/@plurnk/gbnf/dist/src/index.js";

const SVC = "/home/hyzen/repo/plurnk/plurnk-service";
const GRAMMAR = readFileSync(`${SVC}/node_modules/@plurnk/plurnk-grammar/dist/plurnk.gbnf`, "utf-8");
const messages = [
    { role: "system", content: readFileSync(`${SVC}/test/digest/packet001.system.md`, "utf-8") },
    { role: "user", content: readFileSync(`${SVC}/test/digest/packet001.user.md`, "utf-8") },
];

const LLAMA = (process.env.PLURNK_LLAMA_URL ?? "http://127.0.0.1:11435").replace(/\/$/, "");
const FW = "https://api.fireworks.ai/inference/v1";
const FW_KEY = process.env.FIREWORKS_API_KEY;
const FW_MODEL = "accounts/fireworks/models/deepseek-v4-flash";

const post = async (url, body, headers = {}) => {
    const t0 = Date.now();
    const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180_000),
    });
    const ms = Date.now() - t0;
    if (!res.ok) return { ms, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 140)}` };
    const j = await res.json();
    const msg = j.choices?.[0]?.message ?? {};
    return {
        ms,
        content: typeof msg.content === "string" ? msg.content : "",
        reasoning: typeof (msg.reasoning_content ?? msg.reasoning) === "string" ? (msg.reasoning_content ?? msg.reasoning) : "",
        finish: j.choices?.[0]?.finish_reason ?? null,
        completion: j.usage?.completion_tokens ?? null,
    };
};

const grade = (r) => {
    if (r.error) return { ...r, verdict: "ERROR" };
    let verdict;
    try {
        const v = validateGbnf(GRAMMAR, r.content);
        verdict = v.status === "accept" ? "CONFORMANT" : `${v.status}@${v.pos}`;
    } catch { verdict = "unverifiable"; }
    return { ...r, verdict };
};

const row = (label, r) => {
    const head = (r.content ?? "").slice(0, 48).replace(/\n/g, "\\n");
    console.log(
        `${label.padEnd(44)} ${String(r.ms).padStart(6)}ms  finish=${String(r.finish).padEnd(6)} ` +
        `tok=${String(r.completion).padStart(5)}  reason=${String((r.reasoning ?? "").length).padStart(5)}c  ` +
        `${(r.verdict ?? "").padEnd(16)} ${JSON.stringify(head)}${r.error ? "  " + r.error : ""}`,
    );
};

console.log(`packet: system ${messages[0].content.length}c + user ${messages[1].content.length}c | grammar ${GRAMMAR.length}c (0.74.49)`);

// — gemma / llama-server —
console.log("\n=== gemma / llama-server ===");
for (const mode of ["ingrammar", "lazy"]) {
    for (const thinking of [false, true]) {
        for (const cap of [1024, 4096]) {
            const body = {
                model: "gemma", messages, max_tokens: cap,
                temperature: 0.2, repeat_penalty: 1.15,
                grammar: GRAMMAR,
                chat_template_kwargs: { enable_thinking: thinking },
                ...(mode === "lazy" ? { grammar_lazy: true, grammar_triggers: [{ type: 1, value: "<<PLAN" }] } : {}),
            };
            row(`gemma ${mode} think=${thinking ? "on " : "off"} cap=${cap}`, grade(await post(`${LLAMA}/v1/chat/completions`, body)));
        }
    }
}

// — fireworks / deepseek-v4-flash —
console.log("\n=== fireworks / deepseek-v4-flash ===");
for (const effort of ["none", "high"]) {
    for (const cap of [1024, 4096]) {
        const body = {
            model: FW_MODEL, messages, max_tokens: cap,
            temperature: 0.2, repetition_penalty: 1.15,
            reasoning_effort: effort,
            response_format: { type: "grammar", grammar: GRAMMAR },
        };
        row(`fw effort=${effort.padEnd(4)} cap=${cap}`, grade(await post(`${FW}/chat/completions`, body, { authorization: `Bearer ${FW_KEY}` })));
    }
}
