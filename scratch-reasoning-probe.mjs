// Determine deepseek-v4's reasoning format on Fireworks and whether a GBNF can
// swallow it. (1) raw delivery: no grammar, inspect how reasoning arrives.
// (2) grammar swallow: require <think>…</think> then terminal SEND — clean fill
// confirms the delimiter + the swallow-then-strict design; degeneration refutes.
import { readFile } from "node:fs/promises";
process.loadEnvFile(".env");
const KEY = process.env.FIREWORKS_API_KEY;
const URL = "https://api.fireworks.ai/inference/v1/chat/completions";
const MODEL = "accounts/fireworks/models/deepseek-v4-flash";

const system = await readFile("/home/hyzen/repo/plurnk/plurnk-service/test/digest/packet001.system.md", "utf8");
const messages = [
    { role: "system", content: system },
    { role: "user", content: "Describe this project in one sentence, then SEND it: <<SEND[200]:<one sentence>:SEND" },
];

const call = async (grammar, maxTokens, rawDump = false) => {
    const body = { model: MODEL, messages, stream: true, stream_options: { include_usage: true }, max_tokens: maxTokens,
        ...(grammar ? { response_format: { type: "grammar", grammar } } : {}) };
    const res = await fetch(URL, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` }, body: JSON.stringify(body) });
    if (!res.ok) return { error: `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}` };
    let content = "", reasoning = "", finish = null, usage = null, rawCount = 0;
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
            const delta = j.choices?.[0]?.delta;
            if (j.choices?.[0]?.finish_reason) finish = j.choices[0].finish_reason;
            if (rawDump && rawCount < 6 && delta && (delta.content || delta.reasoning_content)) {
                console.log(`   raw delta[${rawCount}]: ${JSON.stringify(delta).slice(0, 160)}`);
                rawCount++;
            }
            content += delta?.content ?? ""; reasoning += delta?.reasoning_content ?? "";
        }
    }
    return { content, reasoning, finish, compTok: usage?.completion_tokens ?? 0 };
};

console.log("══ (1) RAW DELIVERY — no grammar — how does reasoning arrive? ══");
const r1 = await call(null, 400, true);
console.log(`   content starts with <think>? ${r1.content.trimStart().startsWith("<think")}`);
console.log(`   literal "<think" in content? ${r1.content.includes("<think")} | in reasoning? ${r1.reasoning.includes("<think")}`);
console.log(`   content[0:80]   : ${JSON.stringify(r1.content.slice(0, 80))}`);
console.log(`   reasoning[0:80] : ${JSON.stringify(r1.reasoning.slice(0, 80))}`);
console.log(`   lengths: content=${r1.content.length} reasoning=${r1.reasoning.length} finish=${r1.finish}`);

console.log("\n══ (2) GRAMMAR SWALLOW — require <think>…</think> then SEND ══");
const grammar = [
    'root ::= think sep send',
    'think ::= "<think>" thinkbody "</think>"',
    'thinkbody ::= ([^<] | "<" [^/])*',
    'sep ::= ws ws ws ws ws ws ws',
    'ws ::= [ \\t\\r\\n]?',
    'send ::= "<<SEND[" status "]:" body ":SEND"',
    'status ::= "102" | "200" | "202" | "499"',
    'body ::= ([^:] | ":" [^S])*',
].join("\n");
for (let i = 0; i < 3; i++) {
    const r = await call(grammar, 700);
    if (r.error) { console.log(`   run ${i}: ${r.error}`); continue; }
    const c = r.content.trimStart();
    console.log(`   run ${i}: finish=${r.finish} cLen=${r.content.length} rLen=${r.reasoning.length} startsThink=${c.startsWith("<think")} hasSEND=${/<<SEND\[/.test(r.content)}`);
    console.log(`      content[0:140]: ${JSON.stringify(c.slice(0, 140))}`);
    if (r.reasoning.length) console.log(`      reasoning[0:80]: ${JSON.stringify(r.reasoning.slice(0, 80))}`);
}
