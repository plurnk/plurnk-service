// Proper gemma test: reasoning ON (deepseek-style), real system prompt, real
// task, real budget. Does it reason in <think> then emit clean ops + terminal
// SEND under plurnk.gbnf (root-think)?
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { standardProviderFromEnv } from "@plurnk/plurnk-providers";

process.loadEnvFile(".env");
process.loadEnvFile(".env.example");

const grammar = await readFile(fileURLToPath(import.meta.resolve("@plurnk/plurnk-grammar/plurnk.gbnf")), "utf8");
const system = await readFile("/home/hyzen/repo/plurnk/plurnk-service/test/digest/packet001.system.md", "utf8");
const user = "What is the capital of France? Store it under known:///france/capital, then terminate.";

const env = { ...process.env, PLURNK_PROVIDERS_REASONING_BUDGET: "-1" } as NodeJS.ProcessEnv;
const provider = await standardProviderFromEnv("openai", env, "macher.gguf");
if (!provider) throw new Error("no provider");

const t0 = Date.now();
const res = await provider.generate({
    runId: "r",
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
    grammar, maxTokens: 1500,
});
const a = res.assistant;
const c = a.content as string;
const think = c.match(/^<think>([\s\S]*?)<\/think>/);
const afterThink = think ? c.slice(think[0].length).trimStart() : c.trimStart();
console.log(`finish: ${a.finishReason} | ${Date.now() - t0}ms | content ${c.length} chars`);
console.log("has <think>…</think> block:", !!think, think ? `(${think[1].length} reasoning chars)` : "");
console.log("after </think> starts with op (<<):", afterThink.startsWith("<<"));
console.log("has terminal SEND:", /<<SEND\[(102|200|202|499)\]/.test(c));
console.log("leaked specials (<|...|>):", /<\|[a-z_]+\|>/.test(c));
console.log("\n--- after </think> (the DSL) ---");
console.log(afterThink.slice(0, 400));
