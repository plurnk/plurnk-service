// Release-time generator. Fetches Models.dev and vendors the provider facts
// needed to construct an AI SDK provider plus the pruned model facts PLURNK
// consumes. Run on the release cadence:
//   npm run generate
// The snapshot is committed; there is no Models.dev request at install or
// runtime. {§model-fact-resolution} owns each field's runtime precedence.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE = "https://models.dev/api.json";

// Package mechanics are the only support boundary. Vendor membership comes
// entirely from models.dev: every provider using an SDK package we ship is
// included automatically.
const SUPPORTED_NPM = new Set([
    "@ai-sdk/amazon-bedrock",
    "@ai-sdk/anthropic",
    "@ai-sdk/cerebras",
    "@ai-sdk/deepinfra",
    "@ai-sdk/google",
    "@ai-sdk/groq",
    "@ai-sdk/mistral",
    "@ai-sdk/openai",
    "@ai-sdk/openai-compatible",
    "@ai-sdk/togetherai",
    "@ai-sdk/xai",
    "@openrouter/ai-sdk-provider",
]);

// One models.dev model entry → our pruned ModelInfo, or null if it has no usable
// context window (the field we anchor on).
const prune = (m) => {
    const contextWindow = m?.limit?.context;
    if (typeof contextWindow !== "number" || contextWindow <= 0) return null;
    const info = { contextWindow };
    // Retain the source's model-specific output limit when present.
    const maxOutput = m?.limit?.output;
    if (typeof maxOutput === "number" && maxOutput > 0) info.maxOutput = maxOutput;
    // The capability bit is informational. Runtime activation and wire style are
    // provider concerns, not catalog fields. Store only an asserted true value.
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
const providersCatalog = {};
let providers = 0, models = 0, dropped = 0;
for (const [id, entry] of Object.entries(db)) {
    if (!SUPPORTED_NPM.has(entry.npm)) continue;
    providersCatalog[id] = {
        id: entry.id,
        npm: entry.npm,
        env: entry.env ?? [],
        ...(entry.api === undefined ? {} : { api: entry.api }),
    };
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
await fs.writeFile(path.join(dir, "providers.json"), JSON.stringify(providersCatalog, null, 0) + "\n", "utf-8");
console.log(`vendored ${models} models across ${providers} providers (${dropped} dropped for no context window) from ${SOURCE}`);
