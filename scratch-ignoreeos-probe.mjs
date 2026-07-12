// Attack the EOS bail directly: ban EOS (ignore_eos) so the model cannot exit
// an unfinished grammar — forcing it to traverse to the terminal SEND.
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

const run = async (extra, dump = false) => {
    const body = { model: MODEL, messages, stream: true, stream_options: { include_usage: true }, max_tokens: 3000, response_format: { type: "grammar", grammar: g }, ...extra };
    const res = await fetch(URL, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` }, body: JSON.stringify(body) });
    if (!res.ok) return { error: `HTTP ${res.status}: ${(await res.text()).slice(0, 240)}` };
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
    // does content END at the terminal SEND, or run garbage past it?
    const sendIdx = content.lastIndexOf(":SEND");
    const tailAfterSend = sendIdx >= 0 ? content.slice(sendIdx + 5).trim().length : -1;
    return { finish, compTok: usage?.completion_tokens ?? 0, cLen: content.length, rLen: reasoning.length,
        ops: (content.match(/<</g) || []).length, hasSend: /<<SEND\[(102|200|202|499)\]/.test(content),
        tailAfterSend, contentTail: content.slice(-60).replace(/\n/g, "⏎") };
};

// confirm Fireworks accepts ignore_eos
console.log("param check:");
const probe = await run({ ignore_eos: true });
console.log(probe.error ? `   ignore_eos rejected: ${probe.error}` : "   ignore_eos accepted (200)");

console.log("\nignore_eos=true — 5 runs (does every run reach a terminal SEND?):");
const rs = [];
for (let i = 0; i < 5; i++) rs.push(await run({ ignore_eos: true }));
const ok = rs.filter(r => !r.error && r.hasSend).length;
console.log(`SEND reached: ${ok}/${rs.length}`);
for (const [i, r] of rs.entries()) {
    if (r.error) { console.log(`  run ${i}: ${r.error}`); continue; }
    console.log(`  run ${i}: finish=${r.finish} compTok=${r.compTok} ops=${r.ops} SEND=${r.hasSend ? "Y" : "·"} tailAfterSend=${r.tailAfterSend} tail="${r.contentTail}"`);
}
