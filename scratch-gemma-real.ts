// Real gemma calls: same grammar, reasoning ON (-1, enable_thinking:true) vs
// OFF (0, enable_thinking:false). §13 says a live thinking channel is fatal under
// an active grammar — confirm the conflict and the fix empirically.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { standardProviderFromEnv } from "@plurnk/plurnk-providers";

process.loadEnvFile(".env");
process.loadEnvFile(".env.example");

const variant = process.env.PLURNK_PROVIDERS_GBNF!;
const grammar = await readFile(fileURLToPath(import.meta.resolve(`@plurnk/plurnk-grammar/${variant}`)), "utf8");
const prompt = "What is the capital of France? Use known:///france/capital and finish with <<SEND[200]:...:SEND.";

for (const budget of ["-1", "0"]) {
    const env = { ...process.env, PLURNK_PROVIDERS_REASONING_BUDGET: budget } as NodeJS.ProcessEnv;
    const provider = await standardProviderFromEnv("openai", env, "macher.gguf");
    if (!provider) throw new Error("no provider");
    const t0 = Date.now();
    let res: any;
    try { res = await provider.generate({ runId: "r", messages: [{ role: "user", content: prompt }], grammar, maxTokens: 400 }); }
    catch (e: any) { console.log(`\n── budget ${budget}: ERROR ${e.message}`); continue; }
    const a = res.assistant;
    const c = a.content as string;
    console.log(`\n── reasoning budget ${budget} (enable_thinking:${budget !== "0"}) — ${Date.now() - t0}ms ──`);
    console.log("finish:", a.finishReason, "| content chars:", c.length, "| reasoning chars:", a.reasoning?.length ?? 0);
    console.log("valid DSL (starts <<):", c.trimStart().startsWith("<<"), "| has SEND:", /<<SEND\[/.test(c));
    console.log("content[0:220]:", JSON.stringify(c.slice(0, 220)));
}
