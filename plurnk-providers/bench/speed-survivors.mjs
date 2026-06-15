// Speed story for the surviving candidates: decode tok/s AND total tokens AND
// wall-clock per turn (what an agentic loop actually pays). Median-of-3, slot 0.
import { readFileSync } from "node:fs";
const BASE = "http://127.0.0.1:11435";
const G = "/home/hyzen/repo/plurnk/plurnk-service/node_modules/@plurnk/plurnk-grammar";
const system = readFileSync(`${G}/plurnk.md`, "utf8");
const gr = {
    none: null,
    free: readFileSync(`${G}/dist/plurnk-free.gbnf`, "utf8"),
    strict: readFileSync(`${G}/dist/plurnk-strict.gbnf`, "utf8"),
};
const TASKS = [
    "A farmer has 17 sheep. All but 9 die. How many sheep are left? Deliver only the number with a SEND.",
    "I have 6 apples. I eat 2, then give away half of what remains. How many left? Deliver only the number with a SEND.",
    "A train goes 60 miles hour one, 80 hour two, half of hour two in hour three. Total miles? Deliver only the number with a SEND.",
];

const slotsIdle = async () => (await (await fetch(`${BASE}/slots`)).json()).every((s) => !s.is_processing);

const call = async ({ grammar, think, prefill }, prompt) => {
    const messages = [{ role: "system", content: system }, { role: "user", content: prompt }];
    if (prefill) messages.push({ role: "assistant", content: prefill });
    const t0 = Date.now();
    const res = await fetch(`${BASE}/v1/chat/completions`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages, max_tokens: 2500, temperature: 0, id_slot: 0, repeat_penalty: 1.15, chat_template_kwargs: { enable_thinking: think }, ...(gr[grammar] ? { grammar: gr[grammar] } : {}) }),
        signal: AbortSignal.timeout(150_000),
    });
    const wall = Date.now() - t0;
    const j = await res.json();
    return { tps: j.timings?.predicted_per_second ?? 0, out: j.usage.completion_tokens, wall };
};

const median = (a) => a.toSorted((x, y) => x - y)[Math.floor(a.length / 2)];
const CONFIGS = [
    { label: "none/noth   (raw ceiling) ", grammar: "none", think: false },
    { label: "strict/noth (floor)       ", grammar: "strict", think: false },
    { label: "strict+PLAN-prefill       ", grammar: "strict", think: false, prefill: "<<PLAN:\n" },
    { label: "free/think                ", grammar: "free", think: true },
    { label: "none/think                ", grammar: "none", think: true },
];

console.log(`slots idle at start: ${await slotsIdle()}\n`);
console.log("config                      tok/s   out-tok   wall/turn");
for (const cfg of CONFIGS) {
    const tps = [], out = [], wall = [];
    for (const t of TASKS) { const r = await call(cfg, t); tps.push(Math.round(r.tps)); out.push(r.out); wall.push(r.wall); }
    console.log(`${cfg.label} ${String(median(tps)).padStart(4)}   ${String(Math.round(out.reduce((a, b) => a + b) / 3)).padStart(5)}     ${(median(wall) / 1000).toFixed(1)}s`);
}
console.log(`\nslots idle at end: ${await slotsIdle()}`);
