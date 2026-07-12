// Early-EOS root-cause probe on flash: (a) dump full usage telemetry on the
// failing case, (b) test whether Fireworks honors min_tokens and whether it
// eliminates the early bail. Same composed grammar as the validate run.
import { readFile } from "node:fs/promises";
process.loadEnvFile(".env");
const KEY = process.env.FIREWORKS_API_KEY;
const URL = "https://api.fireworks.ai/inference/v1/chat/completions";
const GDIR = "/home/hyzen/repo/plurnk/plurnk-grammar/dist";
const DIG = "/home/hyzen/repo/plurnk/plurnk-service/test/digest";
const MODEL = "accounts/fireworks/models/deepseek-v4-flash";

let g = await readFile(`${GDIR}/plurnk.gbnf`, "utf8");
g = g.replace(/^root ::= root-plan$/m, [
    'root ::= think sep batch-step* send-final-any sep',
    'think ::= "<think>" thinkbody "</think>"',
    'thinkbody ::= ([^<] | "<" [^/])*',
].join("\n"));
g = g.replace(/ \| plan-1 \| plan-2 \| plan-3 \| plan-4 \| plan-5 \| plan-6 \| plan-7 \| plan-8 \| plan-9/g, "");

const [system, userRaw] = await Promise.all([
    readFile(`${DIG}/packet001.system.md`, "utf8"),
    readFile(`${DIG}/packet001.user.md`, "utf8"),
]);
const user = userRaw.replace(/^.*begin every response with <<PLAN.*$\n?/m, "");
const messages = [{ role: "system", content: system }, { role: "user", content: user }];

const run = async (extra, dumpUsage = false) => {
    const body = { model: MODEL, messages, stream: true, stream_options: { include_usage: true }, max_tokens: 3000, response_format: { type: "grammar", grammar: g }, ...extra };
    const res = await fetch(URL, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` }, body: JSON.stringify(body) });
    if (!res.ok) return { error: `HTTP ${res.status}: ${(await res.text()).slice(0, 220)}` };
    let content = "", reasoning = "", usage = null, finish = null;
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
            content += delta?.content ?? ""; reasoning += delta?.reasoning_content ?? "";
        }
    }
    if (dumpUsage) console.log(`   full usage: ${JSON.stringify(usage)}`);
    return { finish, compTok: usage?.completion_tokens ?? 0, cLen: content.length, rLen: reasoning.length,
        hasSend: /<<SEND\[(102|200|202|499)\]/.test(content), ops: (content.match(/<</g) || []).length };
};

const summarize = (label, rs) => {
    const ok = rs.filter(r => !r.error && r.hasSend).length;
    console.log(`\n${label}: ${ok}/${rs.length} reached a terminal SEND`);
    for (const [i, r] of rs.entries()) {
        if (r.error) { console.log(`   run ${i}: ${r.error}`); continue; }
        console.log(`   run ${i}: finish=${r.finish} compTok=${r.compTok} ops=${r.ops} SEND=${r.hasSend ? "Y" : "·"} cLen=${r.cLen} rLen=${r.rLen}`);
    }
};

console.log("Reading usage telemetry (one run):");
await run({}, true);

const base = []; for (let i = 0; i < 4; i++) base.push(await run({}));
summarize("BASELINE (no min_tokens)", base);

const mt = []; for (let i = 0; i < 4; i++) mt.push(await run({ min_tokens: 600 }));
summarize("min_tokens=600", mt);
