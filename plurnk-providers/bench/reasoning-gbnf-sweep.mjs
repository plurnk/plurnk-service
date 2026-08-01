// Live config sweep on local gemma: tokens/sec + objective quality across the
// reasoning × grammar matrix. NOT a unit test — needs llama-server at
// PLURNK_LLAMA_URL (default 127.0.0.1:11435) and the @plurnk/plurnk-contracts
// artifacts (resolved from plurnk-service's install; dev-only, not a dep).
//
//   node bench/reasoning-gbnf-sweep.mjs
//
// Quality is graded objectively (no judge model): PlurnkParser parseability,
// clean termination (finish_reason=stop), and answer-presence on checkable
// tasks. tok/s is llama-server's timings.predicted_per_second (decode only).
import { readFileSync } from "node:fs";

const BASE = process.env.PLURNK_LLAMA_URL ?? "http://127.0.0.1:11435";
const GRAMMAR = "/home/hyzen/repo/plurnk/plurnk-service/node_modules/@plurnk/plurnk-contracts";
const { PlurnkParser } = await import(`${GRAMMAR}/dist/src/grammar.js`);

const gbnf = (name) => readFileSync(`${GRAMMAR}/dist/${name}.gbnf`, "utf8");
const system = (() => {
    for (const p of [`${GRAMMAR}/plurnk.md`, "/home/hyzen/ptl/plurnk-service/plurnk-contracts/plurnk.md"]) {
        try { return readFileSync(p, "utf8"); } catch { /* next */ }
    }
    throw new Error("plurnk.md not found");
})();

// — grammar variants (0.41.0 ships them as distinct artifacts) —
const GRAMMARS = {
    none: null,
    free: gbnf("plurnk-free"),       // root-open: free text, ops optional (lenient)
    commit: gbnf("plurnk"),          // root-commit: the shipped default
    closed: gbnf("plurnk-closed"),   // root-closed: text + steps + forced terminal SEND
    strict: gbnf("plurnk-strict"),   // root-strict: ops only + forced SEND
};

// — config matrix: grammar × thinking, repeat_penalty 1.15 whenever constrained —
const CONFIGS = [];
for (const g of Object.keys(GRAMMARS)) {
    for (const think of [false, true]) {
        CONFIGS.push({ label: `${g}/${think ? "think" : "noth"}`, grammar: g, think, rp: g === "none" ? 1.0 : 1.15 });
    }
}
// one control: strict grammar WITHOUT the repeat-penalty floor (degeneration probe)
CONFIGS.push({ label: "strict/noth/rp1.0", grammar: "strict", think: false, rp: 1.0 });

// — checkable tasks —
const TASKS = [
    { id: "math", prompt: "What is 17 multiplied by 23? Deliver the final answer with a SEND.", answer: "391", minOps: 1 },
    { id: "fact", prompt: "What is the capital of France? Deliver the answer with a SEND.", answer: "paris", minOps: 1 },
    { id: "two-op", prompt: "Compute 6 times 7. Record the result as a known entry, then deliver the number with a SEND.", answer: "42", minOps: 2 },
];

const MAX_TOKENS = 512;

const generate = async ({ grammar, think, rp }, task) => {
    const body = {
        messages: [{ role: "system", content: system }, { role: "user", content: task.prompt }],
        max_tokens: MAX_TOKENS, temperature: 0, id_slot: 0,
        chat_template_kwargs: { enable_thinking: think },
        ...(GRAMMARS[grammar] !== null ? { grammar: GRAMMARS[grammar], repeat_penalty: rp } : {}),
    };
    const t0 = Date.now();
    const res = await fetch(`${BASE}/v1/chat/completions`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(180_000),
    });
    const j = await res.json();
    if (j.error) return { error: JSON.stringify(j.error).slice(0, 80) };
    const choice = j.choices[0];
    const content = choice.message.content ?? "";
    const parsed = PlurnkParser.parse(content);
    const statements = parsed.items.filter((i) => i.kind === "statement").length;
    const errors = parsed.items.filter((i) => i.kind === "error").length;
    return {
        tps: j.timings?.predicted_per_second ?? (j.usage.completion_tokens / ((Date.now() - t0) / 1000)),
        outTok: j.usage.completion_tokens,
        reasonChars: (choice.message.reasoning_content ?? "").length,
        finish: choice.finish_reason,
        parseable: errors === 0 && parsed.unparsedTail === undefined,
        statements,
        terminated: choice.finish_reason === "stop",
        correct: content.toLowerCase().includes(task.answer) && statements >= task.minOps,
    };
};

const pct = (n, d) => `${Math.round((n / d) * 100)}%`;
const rows = [];
for (const cfg of CONFIGS) {
    const results = [];
    for (const task of TASKS) results.push(await generate(cfg, task));
    const ok = results.filter((r) => !r.error);
    const avg = (f) => ok.length ? Math.round(ok.reduce((s, r) => s + f(r), 0) / ok.length) : 0;
    rows.push({
        cfg: cfg.label,
        tps: avg((r) => r.tps),
        outTok: avg((r) => r.outTok),
        reason: avg((r) => r.reasonChars),
        parse: pct(ok.filter((r) => r.parseable).length, TASKS.length),
        term: pct(ok.filter((r) => r.terminated).length, TASKS.length),
        correct: pct(ok.filter((r) => r.correct).length, TASKS.length),
        errs: results.filter((r) => r.error).length,
    });
    const r = rows.at(-1);
    console.log(`${r.cfg.padEnd(20)} tok/s=${String(r.tps).padStart(4)}  out=${String(r.outTok).padStart(4)}  reason=${String(r.reason).padStart(5)}  parse=${r.parse.padStart(4)}  term=${r.term.padStart(4)}  correct=${r.correct.padStart(4)}${r.errs ? `  ERR=${r.errs}` : ""}`);
}

console.log("\n=== summary (sorted by correct, then tok/s) ===");
console.log("config               tok/s   out  reason  parse  term  correct");
for (const r of rows.toSorted((a, b) => parseInt(b.correct) - parseInt(a.correct) || b.tps - a.tps)) {
    console.log(`${r.cfg.padEnd(20)} ${String(r.tps).padStart(5)} ${String(r.outTok).padStart(5)} ${String(r.reason).padStart(7)} ${r.parse.padStart(6)} ${r.term.padStart(5)} ${r.correct.padStart(8)}`);
}
