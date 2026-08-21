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
const prune = (providerId, modelId, m) => {
    const contextWindow = m?.limit?.context;
    if (typeof contextWindow !== "number" || contextWindow <= 0) return null;
    if (typeof m?.name !== "string" || m.name.length === 0) {
        throw new Error(`Models.dev model ${providerId}/${modelId} has no display name`);
    }
    for (const capability of ["attachment", "reasoning", "tool_call"]) {
        if (typeof m[capability] !== "boolean") {
            throw new Error(`Models.dev model ${providerId}/${modelId} has no ${capability} capability fact`);
        }
    }
    if (!Array.isArray(m?.modalities?.input) || !Array.isArray(m?.modalities?.output)) {
        throw new Error(`Models.dev model ${providerId}/${modelId} has no modalities fact`);
    }
    const info = {
        name: m.name,
        contextWindow,
        attachment: m.attachment,
        reasoning: m.reasoning,
        toolCall: m.tool_call,
        modalities: {
            input: m.modalities.input,
            output: m.modalities.output,
        },
    };
    // Context, input, and output are independent Models.dev facts. Neither
    // specialized limit can be reconstructed safely from the other two.
    const maxInputTokens = m?.limit?.input;
    if (typeof maxInputTokens === "number" && maxInputTokens > 0) info.maxInputTokens = maxInputTokens;
    const maxOutputTokens = m?.limit?.output;
    if (typeof maxOutputTokens === "number" && maxOutputTokens > 0) info.maxOutputTokens = maxOutputTokens;
    for (const [source, target] of [
        ["structured_output", "structuredOutput"],
        ["temperature", "temperature"],
    ]) {
        if (typeof m?.[source] === "boolean") info[target] = m[source];
    }
    const c = m?.cost;
    if (c && typeof c.input === "number" && typeof c.output === "number") {
        info.cost = { inputPer1M: c.input, outputPer1M: c.output };
        if (typeof c.reasoning === "number") info.cost.reasoningPer1M = c.reasoning;
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
    if (typeof entry.name !== "string" || entry.name.length === 0) {
        throw new Error(`Models.dev provider ${id} has no display name`);
    }
    providersCatalog[id] = {
        id: entry.id,
        name: entry.name,
        npm: entry.npm,
        env: entry.env ?? [],
        ...(entry.api === undefined ? {} : { api: entry.api }),
    };
    const out = {};
    for (const [modelId, m] of Object.entries(entry.models ?? {})) {
        const info = prune(id, modelId, m);
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
