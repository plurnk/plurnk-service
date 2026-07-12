import { readFileSync } from "node:fs";
const SVC = "/home/hyzen/repo/plurnk/plurnk-service";
const GRAMMAR = readFileSync(`${SVC}/node_modules/@plurnk/plurnk-grammar/dist/plurnk.gbnf`, "utf-8");
const messages = [
  { role: "system", content: readFileSync(`${SVC}/test/digest/packet001.system.md`, "utf-8") },
  { role: "user", content: readFileSync(`${SVC}/test/digest/packet001.user.md`, "utf-8") },
];
const FW = "https://api.fireworks.ai/inference/v1";
const looksLikeProse = (c) => !c.trimStart().startsWith("<"); // DSL starts with '<<'; prose doesn't
const cell = async (label, { model, effort, grammar, stream = false }) => {
  const body = { model: `accounts/fireworks/models/${model}`, messages, max_tokens: 2048, temperature: 0.2,
    ...(effort !== undefined ? { reasoning_effort: effort } : {}),
    ...(grammar ? { response_format: { type: "grammar", grammar: GRAMMAR }, repetition_penalty: 1.15 } : {}),
    ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}) };
  const res = await fetch(`${FW}/chat/completions`, { method: "POST",
    headers: { Authorization: `Bearer ${process.env.FIREWORKS_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(180000) });
  if (!res.ok) { console.log(`${label}: HTTP ${res.status} ${(await res.text()).slice(0,120)}`); return; }
  let content = "", reasoning = "", ur = null, uc = null;
  if (stream) {
    const txt = await res.text();
    for (const line of txt.split("\n")) {
      if (!line.startsWith("data:")) continue; const p = line.slice(5).trim(); if (p === "[DONE]" || !p) continue;
      const ch = JSON.parse(p); const d = ch.choices?.[0]?.delta ?? {};
      if (typeof d.content === "string") content += d.content;
      if (typeof d.reasoning_content === "string") reasoning += d.reasoning_content;
      if (ch.usage) { ur = ch.usage.completion_tokens_details?.reasoning_tokens ?? null; uc = ch.usage.completion_tokens; }
    }
  } else {
    const j = await res.json(); const m = j.choices?.[0]?.message ?? {};
    content = m.content ?? ""; reasoning = m.reasoning_content ?? ""; ur = j.usage?.completion_tokens_details?.reasoning_tokens ?? null; uc = j.usage?.completion_tokens;
  }
  const prose = looksLikeProse(content);
  console.log(`${label}`);
  console.log(`  reasoning_content=${reasoning.length}c | usage r=${ur} c=${uc} | content=${content.length}c prose-lead=${prose ? "YES ⚠" : "no (DSL)"}`);
  console.log(`  content head: ${JSON.stringify(content.slice(0, 100))}`);
};
console.log("=== NON-STREAMED (the provider's grammar path) ===");
await cell("flash | no-grammar effort=high", { model: "deepseek-v4-flash", effort: "high", grammar: false });
await cell("flash | GRAMMAR    effort=high", { model: "deepseek-v4-flash", effort: "high", grammar: true });
await cell("flash | GRAMMAR    effort=low ", { model: "deepseek-v4-flash", effort: "low", grammar: true });
await cell("pro   | GRAMMAR    effort=high", { model: "deepseek-v4-pro", effort: "high", grammar: true });
await cell("pro   | GRAMMAR    effort=low ", { model: "deepseek-v4-pro", effort: "low", grammar: true });
console.log("\n=== STREAMED vs NON-STREAMED, same cell (transport mislabel check) ===");
await cell("flash | GRAMMAR low | STREAMED    ", { model: "deepseek-v4-flash", effort: "low", grammar: true, stream: true });
await cell("flash | GRAMMAR low | non-streamed", { model: "deepseek-v4-flash", effort: "low", grammar: true });
