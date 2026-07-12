// THE decisive matrix (#32 reopened / bench survival question): does ANY cloud
// endpoint deliver reasoning AND rails simultaneously? Live wire, REAL packet
// (plurnk-service test/digest packet001), REAL plurnk.gbnf, objective verdicts
// (@plurnk/gbnf validateGbnf on content — the framework's own conformance check).
// No judge model, no vibes: per cell we record HTTP status, finish_reason,
// reasoning_content presence+length, usage split, and the grammar verdict.
//
//   node bench/fireworks-reasoning-rails-matrix.mjs
import { readFileSync } from "node:fs";
import { validateGbnf } from "/home/hyzen/repo/plurnk/plurnk-providers/node_modules/@plurnk/gbnf/dist/src/index.js";

const SVC = "/home/hyzen/repo/plurnk/plurnk-service";
const GRAMMAR = readFileSync(`${SVC}/node_modules/@plurnk/plurnk-grammar/dist/plurnk.gbnf`, "utf-8");
const messages = [
    { role: "system", content: readFileSync(`${SVC}/test/digest/packet001.system.md`, "utf-8") },
    { role: "user", content: readFileSync(`${SVC}/test/digest/packet001.user.md`, "utf-8") },
];

const FW = process.env.FIREWORKS_BASE_URL ?? "https://api.fireworks.ai/inference/v1";
const XAI = process.env.XAI_BASE_URL ?? "https://api.x.ai/v1";

const call = async (base, key, body) => {
    const t0 = Date.now();
    const res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(300_000),
    });
    const ms = Date.now() - t0;
    const text = await res.text();
    if (!res.ok) return { status: res.status, ms, error: text.slice(0, 300) };
    const j = JSON.parse(text);
    const msg = j.choices?.[0]?.message ?? {};
    const u = j.usage ?? {};
    return {
        status: res.status, ms,
        finish: j.choices?.[0]?.finish_reason ?? null,
        content: msg.content ?? "",
        reasoning: msg.reasoning_content ?? null,
        usage: { prompt: u.prompt_tokens, completion: u.completion_tokens, reasoning: u.completion_tokens_details?.reasoning_tokens ?? null },
    };
};

const verdictOf = (content) => {
    if (content === "" || content == null) return "EMPTY";
    try {
        const v = validateGbnf(GRAMMAR, content); // Verdict: {status: accept|incomplete|reject, pos?}
        return v.status === "accept" ? "ACCEPT" : `${v.status.toUpperCase()}@${v.pos}`;
    } catch (e) { return `validator-error: ${e.message.slice(0, 60)}`; }
};

const report = (label, r) => {
    if (r.error !== undefined) { console.log(`\n■ ${label}\n  HTTP ${r.status} (${r.ms}ms): ${r.error}`); return; }
    const v = verdictOf(r.content);
    console.log(`\n■ ${label}`);
    console.log(`  HTTP ${r.status} finish=${r.finish} ${r.ms}ms | usage c=${r.usage.completion} r=${r.usage.reasoning}`);
    console.log(`  reasoning_content: ${r.reasoning === null ? "ABSENT" : `${r.reasoning.length}c  "${r.reasoning.slice(0, 110).replace(/\n/g, "\\n")}..."`}`);
    console.log(`  content (${r.content.length}c) verdict: ${v}`);
    console.log(`  content head: "${r.content.slice(0, 160).replace(/\n/g, "\\n")}"`);
    console.log(`  content tail: "${r.content.slice(-120).replace(/\n/g, "\\n")}"`);
};

const fwBody = (model, effort, grammar) => ({
    model: `accounts/fireworks/models/${model}`,
    messages,
    max_tokens: 4096,
    temperature: 0.2,
    ...(effort !== undefined ? { reasoning_effort: effort } : {}),
    ...(grammar ? { response_format: { type: "grammar", grammar: GRAMMAR }, repetition_penalty: 1.15 } : {}),
});

console.log(`packet: sys ${messages[0].content.length}c + user ${messages[1].content.length}c | grammar ${GRAMMAR.length}c`);

// ── FIREWORKS: deepseek-v4-flash, the full reasoning × grammar matrix ──
const M = "deepseek-v4-flash";
report(`FW ${M} | A. effort=none + GRAMMAR   (control: rails alone)`, await call(FW, process.env.FIREWORKS_API_KEY, fwBody(M, "none", true)));
report(`FW ${M} | B. effort=low  + GRAMMAR`, await call(FW, process.env.FIREWORKS_API_KEY, fwBody(M, "low", true)));
report(`FW ${M} | C. effort=high + GRAMMAR   (THE cell)`, await call(FW, process.env.FIREWORKS_API_KEY, fwBody(M, "high", true)));
report(`FW ${M} | D. effort=high, NO grammar (control: reasoning alone)`, await call(FW, process.env.FIREWORKS_API_KEY, fwBody(M, "high", false)));
report(`FW ${M} | E. effort UNSET + GRAMMAR  (reason-by-default + mask)`, await call(FW, process.env.FIREWORKS_API_KEY, fwBody(M, undefined, true)));

// ── XAI: grok-build — document the rails story on the wire, verbatim ──
report(`XAI grok-build-0.1 | response_format grammar`, await call(XAI, process.env.XAI_API_KEY, {
    model: "grok-build-0.1", messages, max_tokens: 2048, temperature: 0.2,
    response_format: { type: "grammar", grammar: GRAMMAR },
}));
report(`XAI grok-build-0.1 | top-level grammar field (llama.cpp style)`, await call(XAI, process.env.XAI_API_KEY, {
    model: "grok-build-0.1", messages, max_tokens: 2048, temperature: 0.2,
    grammar: GRAMMAR,
}));
