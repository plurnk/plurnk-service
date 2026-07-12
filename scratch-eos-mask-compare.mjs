// Clean EOS-masking discriminator: grammar forces 25 mandatory " la" after "hi",
// prompt invites a 1-token answer. Only true token-level GBNF (EOS masked) forces
// all 25. Run on Fireworks (expected to truncate) vs DeepInfra (vLLM/xgrammar?).
process.loadEnvFile("/home/hyzen/repo/plurnk/plurnk-service/.env");
const FW = process.env.FIREWORKS_API_KEY;
const DI = process.env.DEEPINFRA_API_KEY;
const grammar = `root ::= "hi" item{25}\nitem ::= " la"`;
const prompt = "Just say hi. One word.";
const las = (s) => (s.match(/ la/g) || []).length;

const fw = async () => {
    const r = await fetch("https://api.fireworks.ai/inference/v1/chat/completions", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${FW}` },
        body: JSON.stringify({ model: "accounts/fireworks/models/deepseek-v4-flash", messages: [{ role: "user", content: prompt }], max_tokens: 200, response_format: { type: "grammar", grammar } }),
    });
    if (!r.ok) return { err: `${r.status} ${(await r.text()).slice(0, 160)}` };
    const j = await r.json(); const c = j.choices?.[0]?.message?.content ?? "";
    return { las: las(c), finish: j.choices?.[0]?.finish_reason, tail: c.slice(-40) };
};

const diModels = async () => {
    const r = await fetch("https://api.deepinfra.com/v1/openai/models", { headers: { Authorization: `Bearer ${DI}` } });
    if (!r.ok) return [];
    const j = await r.json(); return (j.data || []).map((m) => m.id);
};
const di = async (model, extra, label) => {
    const r = await fetch("https://api.deepinfra.com/v1/openai/chat/completions", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${DI}` },
        body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], max_tokens: 200, ...extra }),
    });
    if (!r.ok) return { err: `${r.status} ${(await r.text()).slice(0, 200)}` };
    const j = await r.json(); const c = j.choices?.[0]?.message?.content ?? "";
    return { las: las(c), finish: j.choices?.[0]?.finish_reason, tail: c.slice(-40) };
};

console.log("Expected if EOS truly masked: las=25\n");

console.log("── FIREWORKS (deepseek-v4-flash, response_format grammar) ──");
const f = await fw();
console.log(f.err ? `  ERROR ${f.err}` : `  las=${f.las}/25 finish=${f.finish} tail="${f.tail}"  → ${f.las === 25 ? "MASKED" : "NOT masked (truncated)"}`);

console.log("\n── DEEPINFRA ──");
if (!DI) { console.log("  no key"); } else {
    const ids = await diModels();
    const reasoners = ids.filter((id) => /R1|QwQ|reason|think|V3/i.test(id));
    const pick = ids.find((id) => /Qwen2.5-7B-Instruct|Llama-3.1-8B-Instruct|Meta-Llama-3.1-8B/i.test(id)) || ids.find((id) => /8B|7B/.test(id)) || ids[0];
    console.log(`  ${ids.length} models; reasoning candidates: ${reasoners.slice(0, 6).join(", ")}`);
    console.log(`  testing on: ${pick}`);
    // try several param shapes vLLM/DeepInfra might accept
    for (const [label, extra] of [
        ["guided_grammar (top-level)", { guided_grammar: grammar }],
        ["response_format type=grammar", { response_format: { type: "grammar", grammar } }],
        ["extra_body.guided_grammar", { extra_body: { guided_grammar: grammar } }],
    ]) {
        const d = await di(pick, extra, label);
        console.log(`  [${label}] ${d.err ? `ERROR ${d.err}` : `las=${d.las}/25 finish=${d.finish} tail="${d.tail}" → ${d.las === 25 ? "MASKED ✓" : "not masked"}`}`);
    }
}
