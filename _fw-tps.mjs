import fs from "node:fs/promises";
import { instantiateProvider } from "/home/hyzen/repo/plurnk/plurnk-providers/src/index.ts";
const key = process.env.FIREWORKS_API_KEY;
const grammar = await fs.readFile("./node_modules/@plurnk/plurnk-contracts/dist/plurnk.gbnf", "utf-8");
const env = { FIREWORKS_API_KEY:key, PLURNK_FETCH_TIMEOUT:"600000", PLURNK_PROVIDERS_REASONING_BUDGET:"0", PLURNK_PROVIDER_RETRY_ATTEMPTS:"3" };
const PROMPT = "Compute the sum of the first 10 prime numbers. Plan, then send the final answer with a short explanation.";
const bench = async (label, model) => {
  const p = await instantiateProvider("fireworks", env, model);
  const tps = [];
  for (let i=0;i<5;i++){
    const t0=Date.now();
    const r = await p.generate({ runId:"t"+i, messages:[{role:"user",content:PROMPT}], grammar, maxTokens:400 });
    const ms=Date.now()-t0; const out=r.assistant.usage.completion+r.assistant.usage.reasoning;
    const ok = r.assistant.content.trimStart().startsWith("# PLAN1");
    if (ok) tps.push(out/(ms/1000));
    process.stdout.write(`${label} ${ok?"GBNF":"prose"} ${(out/(ms/1000)).toFixed(0)}t/s · `);
  }
  console.log(`\n${label} enforced tok/s: ${tps.length? (tps.reduce((a,b)=>a+b)/tps.length).toFixed(0):"—"} (median ${tps.length?tps.sort((a,b)=>a-b)[Math.floor(tps.length/2)].toFixed(0):"—"}), ${tps.length}/5 runs enforced\n`);
};
await bench("FLASH", "accounts/fireworks/models/deepseek-v4-flash");
await bench("PRO", "accounts/fireworks/models/deepseek-v4-pro");
