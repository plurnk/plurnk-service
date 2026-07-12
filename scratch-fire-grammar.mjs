// Grammar sweep — NO PLAN mandate (DeepSeek reasons natively; PLAN is orthogonal
// and forcing it makes the model bail to empty content). Strips the PLAN-require
// line from the credible packet and drops the PLAN-forcing strict root. Tests
// the config we actually want for DeepSeek: native reasoning → actionable ops →
// terminal SEND, grammar constrains op syntax but never forces PLAN/EOS.
import { readFile } from "node:fs/promises";

process.loadEnvFile(".env");
const KEY = process.env.FIREWORKS_API_KEY;
if (!KEY) throw new Error("FIREWORKS_API_KEY unset");
const URL = "https://api.fireworks.ai/inference/v1/chat/completions";
const GDIR = "/home/hyzen/repo/plurnk/plurnk-grammar/dist";
const DIG = "/home/hyzen/repo/plurnk/plurnk-service/test/digest";

const [system, userRaw, gFree] = await Promise.all([
    readFile(`${DIG}/packet001.system.md`, "utf8"),
    readFile(`${DIG}/packet001.user.md`, "utf8"),
    readFile(`${GDIR}/plurnk-free.gbnf`, "utf8"),
]);
// Remove the PLAN mandate line (the PLURNK_PLAN-gated directive).
const user = userRaw.replace(/^.*begin every response with <<PLAN.*$\n?/m, "");
const removed = user !== userRaw;
console.log(`PLAN mandate line removed: ${removed}\n`);
const messages = [{ role: "system", content: system }, { role: "user", content: user }];

const MODELS = {
    flash: "accounts/fireworks/models/deepseek-v4-flash",
    pro: "accounts/fireworks/models/deepseek-v4-pro",
};
const OPS = "PLAN|FIND|READ|EDIT|COPY|MOVE|OPEN|FOLD|SEND|EXEC|KILL";

const run = async (model, grammar, maxTokens = 2560) => {
    const body = {
        model, messages, stream: true, stream_options: { include_usage: true }, max_tokens: maxTokens,
        ...(grammar ? { response_format: { type: "grammar", grammar } } : {}),
    };
    const t0 = performance.now();
    const res = await fetch(URL, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    let content = "", reasoning = "", tFirst = null, tLast = null, usage = null, finish = null;
    const dec = new TextDecoder(); let buf = "";
    for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        const lines = buf.split("\n"); buf = lines.pop();
        for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const d = line.slice(6).trim();
            if (d === "[DONE]") continue;
            const j = JSON.parse(d);
            if (j.usage) usage = j.usage;
            const delta = j.choices?.[0]?.delta; const fr = j.choices?.[0]?.finish_reason;
            if (fr) finish = fr;
            const piece = (delta?.content ?? "") + (delta?.reasoning_content ?? "");
            if (piece.length > 0) { if (tFirst === null) tFirst = performance.now(); tLast = performance.now(); }
            content += delta?.content ?? ""; reasoning += delta?.reasoning_content ?? "";
        }
    }
    const compTok = usage?.completion_tokens ?? 0;
    const decodeSecs = tFirst && tLast ? (tLast - tFirst) / 1000 : null;
    const trimmed = content.trimStart();
    const firstOp = trimmed.match(new RegExp(`^<<(${OPS})`))?.[1] ?? (trimmed.startsWith("<<") ? "??" : "·prose");
    return {
        compTok, ttft: tFirst ? (tFirst - t0) / 1000 : null,
        decode: decodeSecs && decodeSecs > 0 ? (compTok - 1) / decodeSecs : null,
        contentLen: content.length, reasoningLen: reasoning.length, finish,
        validDSL: trimmed.startsWith("<<"),
        firstOp,
        hasTerminalSend: /<<SEND\[(102|200|202|499)\]/.test(content),
        head: trimmed.slice(0, 56).replace(/\n/g, "⏎"),
    };
};

const CONDITIONS = [
    { name: "no-grammar ", grammar: null, runs: 2 },
    { name: "free       ", grammar: gFree, runs: 3 },
];
const f = (n, w = 6, d = 1) => (n === null ? "n/a".padStart(w) : n.toFixed(d).padStart(w));

for (const [label, model] of Object.entries(MODELS)) {
    console.log(`\n████ ${label} (${model}) ████`);
    console.log("cond         run  compTok  ttft   decode  cLen  rLen  finish  DSL  firstOp  SEND   head");
    for (const c of CONDITIONS) {
        for (let i = 0; i < c.runs; i++) {
            try {
                const r = await run(model, c.grammar);
                console.log(`${c.name}  ${i}   ${String(r.compTok).padStart(6)}  ${f(r.ttft)}  ${f(r.decode)}  ${String(r.contentLen).padStart(4)}  ${String(r.reasoningLen).padStart(4)}  ${(r.finish ?? "?").padEnd(6)}  ${r.validDSL ? "Y" : "·"}   ${r.firstOp.padEnd(7)}  ${r.hasTerminalSend ? "Y" : "·"}    ${r.head}`);
            } catch (e) { console.log(`${c.name}  ${i}   ERROR ${e.message.slice(0, 90)}`); }
        }
    }
}
console.log("\nfirstOp=first op in content (no PLAN expected) · SEND=terminal SEND[status] · cLen/rLen=content/reasoning chars");
