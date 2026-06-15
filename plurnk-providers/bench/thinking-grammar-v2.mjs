// Does native thinking coexist with a grammar that allows free text between
// ops (free/closed roots)? And does a <<PLAN: prefill force reliable in-DSL
// reasoning? Multi-step trap tasks, deepseek server, generous tokens, strict scorer.
import { readFileSync } from "node:fs";
const BASE = "http://127.0.0.1:11435";
const G = "/home/hyzen/repo/plurnk/plurnk-service/node_modules/@plurnk/plurnk-grammar";
const system = readFileSync(`${G}/plurnk.md`, "utf8");
const grammars = {
    none: null,
    free: readFileSync(`${G}/dist/plurnk-free.gbnf`, "utf8"),
    closed: readFileSync(`${G}/dist/plurnk-closed.gbnf`, "utf8"),
    strict: readFileSync(`${G}/dist/plurnk-strict.gbnf`, "utf8"),
};

// multi-step trap tasks (naive single-step answers are wrong)
const TASKS = [
    { id: "sheep ", p: "A farmer has 17 sheep. All but 9 die. How many sheep are left?", a: "9" },
    { id: "apples", p: "I have 6 apples. I eat 2, then give away half of what remains. How many apples do I have left?", a: "2" },
    { id: "train ", p: "A train goes 60 miles the first hour, 80 the second hour, and half of the second hour's distance in the third. Total miles?", a: "180" },
];
const sendHasAnswer = (c, a) => [...c.matchAll(/<<SEND\[\d+\]:([\s\S]*?):SEND/g)].some((m) => m[1].includes(a));
const hasPlan = (c) => /<<PLAN/i.test(c);

const call = async ({ grammar, think, prefill }, task) => {
    const messages = [{ role: "system", content: system }, { role: "user", content: task.p + " Deliver only the final number with a SEND." }];
    if (prefill) messages.push({ role: "assistant", content: prefill });
    const res = await fetch(`${BASE}/v1/chat/completions`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            messages, max_tokens: 2500, temperature: 0, id_slot: 0, repeat_penalty: 1.15,
            chat_template_kwargs: { enable_thinking: think },
            ...(grammars[grammar] ? { grammar: grammars[grammar] } : {}),
        }),
        signal: AbortSignal.timeout(150_000),
    });
    const j = await res.json();
    if (j.error) return { err: JSON.stringify(j.error).slice(0, 70) };
    const m = j.choices[0].message; const c = (prefill ?? "") + (m.content ?? "");
    return { reason: (m.reasoning_content ?? "").length, plan: hasPlan(c), ok: sendHasAnswer(c, task.a), fin: j.choices[0].finish_reason, out: j.usage.completion_tokens };
};

const CONFIGS = [
    { label: "none/think            ", grammar: "none", think: true },
    { label: "free/think            ", grammar: "free", think: true },
    { label: "closed/think          ", grammar: "closed", think: true },
    { label: "strict/noth +PLAN-pre ", grammar: "strict", think: false, prefill: "<<PLAN:\n" },
    { label: "closed/noth +PLAN-pre ", grammar: "closed", think: false, prefill: "<<PLAN:\n" },
];

for (const cfg of CONFIGS) {
    let okN = 0, reasonSum = 0, planN = 0, termN = 0; const errs = [];
    for (const t of TASKS) {
        const r = await call(cfg, t);
        if (r.err) { errs.push(r.err); continue; }
        if (r.ok) okN++; if (r.plan) planN++; if (r.fin === "stop") termN++;
        reasonSum += r.reason;
    }
    console.log(`${cfg.label} correct=${okN}/3 plan=${planN}/3 term=${termN}/3 avgReason=${Math.round(reasonSum / 3)}B${errs.length ? ` ERR:${errs[0]}` : ""}`);
}
