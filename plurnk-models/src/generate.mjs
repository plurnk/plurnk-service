// Release-time generator. Fetches the models.dev catalog and vendors a pruned,
// committed snapshot (src/catalog.json) carrying only the two fields plurnk
// uses as a FALLBACK — context window + pricing. Run on the release cadence:
//   npm run generate
// The snapshot is committed; there is NO network at install or runtime. Live
// provider data always wins over this snapshot (see README) — it only fills the
// gap when a provider exposes no live context/pricing.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE = "https://models.dev/api.json";

// The models.dev provider ids backing plurnk's supported providers. Kept in sync
// with PROVIDER_IDS in index.ts (our provider name → models.dev id). We vendor
// ONLY these — leaner than the full 145-provider catalog, and exactly the set a
// plurnk daemon can actually serve.
const KEEP = [
    "openai", "groq", "deepseek", "mistral", "togetherai", "fireworks-ai",
    "deepinfra", "openrouter", "ollama-cloud", "google", "cloudflare-workers-ai",
    "xai", "anthropic",
    // Chinese cloud hosts (international ids → USD pricing). The standard-provider
    // names that diverge from these ids are mapped in PROVIDER_IDS. volcengine /
    // baichuan / qianfan have NO models.dev provider, so they carry no fallback.
    "moonshotai", "alibaba", "zai", "tencent-tokenhub", "minimax", "stepfun",
    "siliconflow", "modelscope",
];

// One models.dev model entry → our pruned ModelInfo, or null if it has no usable
// context window (the field we anchor on).
const prune = (m) => {
    const contextWindow = m?.limit?.context;
    if (typeof contextWindow !== "number" || contextWindow <= 0) return null;
    const info = { contextWindow };
    // The model's completion cap (#567/defaults-epic): models.dev carries limit.output for
    // every model — the real per-model max output, not a blind window fraction.
    const maxOutput = m?.limit?.output;
    if (typeof maxOutput === "number" && maxOutput > 0) info.maxOutput = maxOutput;
    // models.dev carries a per-model reasoning flag (all models) — the static "does this model
    // reason" fact. The reasoning FORMAT (reasoning_content vs reasoning_effort) stays a
    // per-provider probe, not a catalog field. Stored only when true; absent = non-reasoning.
    if (m?.reasoning === true) info.reasoning = true;
    const c = m?.cost;
    if (c && typeof c.input === "number" && typeof c.output === "number") {
        info.cost = { inputPer1M: c.input, outputPer1M: c.output };
        if (typeof c.cache_read === "number") info.cost.cacheReadPer1M = c.cache_read;
        if (typeof c.cache_write === "number") info.cost.cacheWritePer1M = c.cache_write;
    }
    return info;
};

const res = await fetch(SOURCE, { signal: AbortSignal.timeout(30_000) });
if (!res.ok) throw new Error(`models.dev fetch failed: ${res.status}`);
const db = await res.json();

const catalog = {};
let providers = 0, models = 0, dropped = 0;
for (const id of KEEP) {
    const entry = db[id];
    if (entry === undefined) { console.warn(`! models.dev has no provider "${id}" — skipped`); continue; }
    const out = {};
    for (const [modelId, m] of Object.entries(entry.models ?? {})) {
        const info = prune(m);
        if (info === null) { dropped++; continue; }
        out[modelId] = info;
        models++;
    }
    if (Object.keys(out).length > 0) { catalog[id] = out; providers++; }
}

const dir = path.dirname(fileURLToPath(import.meta.url));
await fs.writeFile(path.join(dir, "catalog.json"), JSON.stringify(catalog, null, 0) + "\n", "utf-8");
console.log(`vendored ${models} models across ${providers} providers (${dropped} dropped for no context window) from ${SOURCE}`);
