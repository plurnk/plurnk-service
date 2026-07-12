// Compose the deepfire grammar deterministically from plurnk.gbnf and validate
// on the credible packet against flash + pro:
//   root ::= <think>…</think> → (mid-op sep){0,98} → terminal SEND   (≤99 ops)
// Reuses every op rule from plurnk.gbnf; swaps only the root; drops plan-1..9
// (keeps plain inert plan); no PLAN mandate in the prompt.
import { readFile } from "node:fs/promises";
process.loadEnvFile(".env");
const KEY = process.env.FIREWORKS_API_KEY;
const URL = "https://api.fireworks.ai/inference/v1/chat/completions";
const GDIR = "/home/hyzen/repo/plurnk/plurnk-grammar/dist";
const DIG = "/home/hyzen/repo/plurnk/plurnk-service/test/digest";

// ── compose grammar ──
let g = await readFile(`${GDIR}/plurnk.gbnf`, "utf8");
// 1) swap the root for the deepfire root + think block
const newRoot = [
    'root ::= think sep batch-step{0,98} send-final-any sep',
    'think ::= "<think>" thinkbody "</think>"',
    'thinkbody ::= ([^<] | "<" [^/])*',
].join("\n");
g = g.replace(/^root ::= root-plan$/m, newRoot);
// 2) drop plan-1..plan-9 from op-statement (keep plain `plan`)
g = g.replace(/ \| plan-1 \| plan-2 \| plan-3 \| plan-4 \| plan-5 \| plan-6 \| plan-7 \| plan-8 \| plan-9/g, "");
const sanity = g.includes("think ::=") && /\| plan(?! -)/.test(g) && !g.includes("plan-9");
console.log(`composed: think-block=${g.includes("think ::=")} plan-kept=${/\bplan\b/.test(g)} plan-9-dropped=${!g.includes("plan-9")}\n`);

// ── credible packet, PLAN mandate stripped ──
const [system, userRaw] = await Promise.all([
    readFile(`${DIG}/packet001.system.md`, "utf8"),
    readFile(`${DIG}/packet001.user.md`, "utf8"),
]);
const user = userRaw.replace(/^.*begin every response with <<PLAN.*$\n?/m, "");
const messages = [{ role: "system", content: system }, { role: "user", content: user }];

const MODELS = { flash: "accounts/fireworks/models/deepseek-v4-flash", pro: "accounts/fireworks/models/deepseek-v4-pro" };
const OPS = "PLAN|FIND|READ|EDIT|COPY|MOVE|OPEN|FOLD|SEND|EXEC|KILL";

const run = async (model) => {
    const body = { model, messages, stream: true, stream_options: { include_usage: true }, max_tokens: 3000, response_format: { type: "grammar", grammar: g } };
    const t0 = performance.now();
    const res = await fetch(URL, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` }, body: JSON.stringify(body) });
    if (!res.ok) return { error: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` };
    let content = "", reasoning = "", tFirst = null, tLast = null, usage = null, finish = null;
    const dec = new TextDecoder(); let buf = "";
    for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        const lines = buf.split("\n"); buf = lines.pop();
        for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const d = line.slice(6).trim(); if (d === "[DONE]") continue;
            const j = JSON.parse(d);
            if (j.usage) usage = j.usage;
            const delta = j.choices?.[0]?.delta; if (j.choices?.[0]?.finish_reason) finish = j.choices[0].finish_reason;
            const piece = (delta?.content ?? "") + (delta?.reasoning_content ?? "");
            if (piece.length > 0) { if (tFirst === null) tFirst = performance.now(); tLast = performance.now(); }
            content += delta?.content ?? ""; reasoning += delta?.reasoning_content ?? "";
        }
    }
    const compTok = usage?.completion_tokens ?? 0;
    const decodeSecs = tFirst && tLast ? (tLast - tFirst) / 1000 : null;
    const c = content.trimStart();
    return {
        compTok, decode: decodeSecs && decodeSecs > 0 ? (compTok - 1) / decodeSecs : null, finish,
        cLen: content.length, rLen: reasoning.length,
        opCount: (content.match(/<</g) || []).length,
        firstOp: c.match(new RegExp(`^<<(${OPS})`))?.[1] ?? (c.startsWith("<<") ? "??" : "·prose"),
        hasSend: /<<SEND\[(102|200|202|499)\]/.test(content),
        reasonHasThink: reasoning.trimStart().startsWith("<think"),
        contentHead: c.slice(0, 90).replace(/\n/g, "⏎"),
    };
};

for (const [label, model] of Object.entries(MODELS)) {
    console.log(`\n████ ${label} ████`);
    for (let i = 0; i < 3; i++) {
        const r = await run(model);
        if (r.error) { console.log(`  run ${i}: ${r.error}`); continue; }
        console.log(`  run ${i}: finish=${r.finish} ops=${r.opCount} firstOp=${r.firstOp} SEND=${r.hasSend ? "Y" : "·"} reasoningHasThink=${r.reasonHasThink ? "Y" : "·"} cLen=${r.cLen} rLen=${r.rLen} decode=${r.decode?.toFixed(0)}t/s`);
        console.log(`     content: ${r.contentHead}`);
    }
}
