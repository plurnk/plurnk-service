import { readFile } from "node:fs/promises";

process.loadEnvFile(".env");
const KEY = process.env.FIREWORKS_API_KEY;
if (!KEY) throw new Error("FIREWORKS_API_KEY unset");

const URL = "https://api.fireworks.ai/inference/v1/chat/completions";
const GDIR = "/home/hyzen/repo/plurnk/plurnk-grammar/dist";
const PDIR = "/home/hyzen/repo/plurnk/plurnk-grammar";

const [plurnkMd, requirementsMd, gFree, gStrict] = await Promise.all([
    readFile(`${PDIR}/plurnk.md`, "utf8"),
    readFile("requirements.md", "utf8"),
    readFile(`${GDIR}/plurnk-free.gbnf`, "utf8"),
    readFile(`${GDIR}/plurnk.gbnf`, "utf8"),
]);

const model = (process.argv[2] ?? "flash") === "pro"
    ? "accounts/fireworks/models/deepseek-v4-pro"
    : "accounts/fireworks/models/deepseek-v4-flash";

// Stream a request. Capture output tokens whether the backend labels them
// content OR reasoning_content (Fireworks mislabels grammar output as the
// latter). Time first vs last output token to isolate DECODE rate from prefill.
const run = async ({ messages, grammar, maxTokens = 512 }) => {
    const body = {
        model, messages, stream: true, stream_options: { include_usage: true },
        max_tokens: maxTokens,
        ...(grammar ? { response_format: { type: "grammar", grammar } } : {}),
    };
    const t0 = performance.now();
    const res = await fetch(URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);

    let content = "", reasoning = "", tFirst = null, tLast = null, usage = null, finish = null;
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6).trim();
            if (data === "[DONE]") continue;
            const j = JSON.parse(data);
            if (j.usage) usage = j.usage;
            const d = j.choices?.[0]?.delta;
            const fr = j.choices?.[0]?.finish_reason;
            if (fr) finish = fr;
            const piece = (d?.content ?? "") + (d?.reasoning_content ?? "");
            if (piece.length > 0) {
                if (tFirst === null) tFirst = performance.now();
                tLast = performance.now();
                content += d?.content ?? "";
                reasoning += d?.reasoning_content ?? "";
            }
        }
    }
    const out = content + reasoning;
    const compTok = usage?.completion_tokens ?? 0;
    const decodeSecs = tFirst !== null && tLast !== null ? (tLast - tFirst) / 1000 : null;
    const decodeRate = decodeSecs && decodeSecs > 0 ? (compTok - 1) / decodeSecs : null;
    return {
        compTok,
        ttftSecs: tFirst !== null ? (tFirst - t0) / 1000 : null,
        decodeRate,
        wallRate: compTok / ((performance.now() - t0) / 1000),
        finish,
        channel: reasoning.length > content.length ? "reasoning_content" : "content",
        sample: out.replace(/\s+/g, " ").trim().slice(0, 120),
    };
};

const fmt = (n) => n === null ? " n/a" : n.toFixed(1).padStart(5);

console.log(`model: ${model}\n`);

// ── 1. ENFORCEMENT PROOF ──────────────────────────────────────────────
// A grammar the model would NEVER emit unprompted. If output is only ALPHA/BETA,
// GBNF is genuinely constraining sampling. If we get prose, it was dropped.
const forcing = `root ::= tok+\ntok ::= "ALPHA" | "BETA"`;
console.log("[1] enforcement proof — forcing grammar, prompt asks for prose:");
for (let i = 0; i < 3; i++) {
    const r = await run({
        messages: [{ role: "user", content: "Write a paragraph about the ocean." }],
        grammar: forcing, maxTokens: 40,
    });
    const conforms = /^(ALPHA|BETA)+$/.test(r.sample.replace(/\s/g, ""));
    console.log(`    run ${i}: conforms=${conforms} chan=${r.channel} "${r.sample.slice(0, 50)}"`);
}

// ── 2. SPEED: same real prompt, three constraint conditions ───────────
const messages = [
    { role: "system", content: plurnkMd },
    { role: "user", content: `${requirementsMd}\n\nBegin with <<PLAN:...:PLAN` },
];
const conditions = [
    { name: "no-grammar  ", grammar: null },
    { name: "plurnk-free ", grammar: gFree },
    { name: "plurnk-strict", grammar: gStrict },
];
console.log("\n[2] decode rate (t/s) on the real prompt — 2 runs each:");
console.log("    condition       run  compTok  ttft(s)  decode(t/s)  wall(t/s)  finish  chan");
for (const c of conditions) {
    for (let i = 0; i < 2; i++) {
        try {
            const r = await run({ messages, grammar: c.grammar, maxTokens: 512 });
            console.log(`    ${c.name}   ${i}   ${String(r.compTok).padStart(6)}   ${fmt(r.ttftSecs)}     ${fmt(r.decodeRate)}      ${fmt(r.wallRate)}   ${(r.finish ?? "?").padEnd(6)} ${r.channel}`);
            console.log(`        ↳ "${r.sample}"`);
        } catch (e) {
            console.log(`    ${c.name}   ${i}   ERROR ${e.message.slice(0, 80)}`);
        }
    }
}
