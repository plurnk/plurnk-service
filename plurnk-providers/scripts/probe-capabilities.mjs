// Capability acceptance probe (#568). Asks each provider's REAL endpoint which sampling
// params it accepts. Acceptance proves wire compatibility, never semantic effect; only
// provider documentation or a controlled behavioral experiment may justify a default.
// Run at release/patch-pub:
//   npm run probe:caps -w @plurnk/plurnk-providers
// Skips any provider with no key; writes the wire-compatibility artifact to
// scripts/capability-profiles.json.
//
// A profile is trustworthy ONLY behind a passing BASELINE call (no extra params): an
// invalid/inaccessible model must never masquerade as param rejection. Candidate models
// are tried in order until one baselines (skips dedicated-only serverless models).

import { writeFileSync } from "node:fs";

const requiredInt = (name) => {
    const raw = process.env[name];
    if (raw === undefined || !/^\d+$/.test(raw)) throw new Error(`${name} must be a non-negative integer`);
    return Number(raw);
};

const REQUEST_TIMEOUT_MS = requiredInt("PLURNK_CAPABILITY_PROBE_REQUEST_TIMEOUT");
const MODEL_LIST_TIMEOUT_MS = requiredInt("PLURNK_CAPABILITY_PROBE_MODEL_LIST_TIMEOUT");
const PARAM_DELAY_MS = requiredInt("PLURNK_CAPABILITY_PROBE_PARAM_DELAY");
const MAX_TOKENS = requiredInt("PLURNK_CAPABILITY_PROBE_MAX_TOKENS");
const MODEL_FALLBACKS = requiredInt("PLURNK_CAPABILITY_PROBE_MODEL_FALLBACKS");

// The sampling params we probe, with a harmless in-range value each.
const CANDIDATES = [
    ["temperature", 0.5], ["top_p", 0.9], ["top_k", 40], ["min_p", 0.05],
    ["frequency_penalty", 0.3], ["presence_penalty", 0.3], ["repetition_penalty", 1.1],
];

// { name, base (chat-completions root), keyVar, models (tried in order until one baselines) }.
// Extend as keys/endpoints are added — a keyless provider is skipped, never guessed.
const PROVIDERS = [
    { name: "openai", base: "https://api.openai.com/v1", keyVar: "OPENAI_API_KEY", models: ["gpt-4o-mini", "gpt-4.1-mini"] },
    { name: "groq", base: "https://api.groq.com/openai/v1", keyVar: "GROQ_API_KEY", models: ["llama-3.1-8b-instant", "llama-3.3-70b", "llama"] },
    { name: "deepseek", base: "https://api.deepseek.com/v1", keyVar: "DEEPSEEK_API_KEY", models: ["deepseek-chat"] },
    { name: "mistral", base: "https://api.mistral.ai/v1", keyVar: "MISTRAL_API_KEY", models: ["ministral-8b-latest", "mistral-small-latest", "mistral"] },
    { name: "together", base: "https://api.together.xyz/v1", keyVar: "TOGETHER_API_KEY", models: ["meta-llama/Llama-3.3-70B-Instruct-Turbo", "mistralai/Mistral-7B-Instruct-v0.3", "Qwen/Qwen2.5-7B-Instruct-Turbo", "Meta-Llama-3.1-8B-Instruct-Turbo"] },
    { name: "fireworks", base: "https://api.fireworks.ai/inference/v1", keyVar: "FIREWORKS_API_KEY", models: ["llama-v3p1-8b", "llama.*8b", "llama"] },
    { name: "deepinfra", base: "https://api.deepinfra.com/v1/openai", keyVar: "DEEPINFRA_API_KEY", models: ["Llama-3.1-8B", "Meta-Llama-3.1-8B", "8B"] },
    { name: "xai", base: "https://api.x.ai/v1", keyVar: "XAI_API_KEY", models: ["grok-3-mini", "grok-2", "grok"] },
    { name: "gemini", base: "https://generativelanguage.googleapis.com/v1beta/openai", keyVar: "GEMINI_API_KEY", models: ["gemini-2.5-flash", "gemini-2.*flash", "flash"] },
    // Anthropic OpenAI-compat. Expected: honors temperature/top_p only (Claude's native param set has no
    // frequency_penalty, top_k, or repetition_penalty); suppressed in standardProviders.ts (DOC #568).
    { name: "anthropic", base: "https://api.anthropic.com/v1", keyVar: "ANTHROPIC_API_KEY", models: ["claude-haiku-4-5-20251001", "claude-3-5-haiku-20241022", "claude-haiku"] },
    // Cloudflare Workers AI: account-scoped URL (built from CLOUDFLARE_ACCOUNT_ID), token in CLOUDFLARE_API_TOKEN.
    { name: "cloudflare", base: `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID ?? "NO_ACCOUNT"}/ai/v1`, keyVar: "CLOUDFLARE_API_TOKEN", models: ["@cf/meta/llama-3.1-8b-instruct", "@cf/meta/llama-3.3-70b-instruct-fp8-fast", "llama-3"] },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chat = async (base, key, body) => {
    try {
        const r = await fetch(`${base}/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        return { status: r.status, ok: r.ok, text: (await r.text()).replace(/\s+/g, " ") };
    } catch (e) { return { status: 0, ok: false, text: `fetch: ${e.message}` }; }
};

// Resolve model candidates against the live /v1/models list (array OR {data:[]}); fall
// back to the raw candidate strings so a provider without a listable /models still probes.
const resolveModels = async (base, key, prefer) => {
    let ids = [];
    try {
        const r = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS) });
        if (r.ok) { const j = await r.json(); ids = (Array.isArray(j) ? j : j.data ?? []).map((m) => m.id).filter(Boolean); }
    } catch { /* no listable /models — fall through to raw candidates */ }
    const out = [];
    for (const p of prefer) { const hit = ids.find((id) => new RegExp(p, "i").test(id)); if (hit && !out.includes(hit)) out.push(hit); else if (!hit && !out.includes(p)) out.push(p); }
    // Fallback: if none of the preferred models baseline (dedicated-only, retired), try other
    // listed chat models so a working serverless one is still found.
    for (const id of ids) {
        if (out.length >= prefer.length + MODEL_FALLBACKS) break;
        if (out.includes(id) || /embed|whisper|tts|image|rerank|moderat|guard|vision|audio|speech/i.test(id)) continue;
        out.push(id);
    }
    return out;
};

const profile = async ({ name, base, keyVar, models }) => {
    const key = process.env[keyVar];
    if (!key) return { name, skipped: `no ${keyVar}` };
    const candidates = await resolveModels(base, key, models);
    let lastFail = null;
    for (const model of candidates) {
        const baseline = await chat(base, key, { model, messages: [{ role: "user", content: "hi" }], max_tokens: MAX_TOKENS });
        if (!baseline.ok) { lastFail = `${model} -> ${baseline.status} ${baseline.text.slice(0, 70)}`; continue; } // auth/dedicated/invalid — try the next candidate
        const accepted = [], rejected = [], anomaly = [];
        for (const [p, v] of CANDIDATES) {
            await sleep(PARAM_DELAY_MS);
            const res = await chat(base, key, { model, messages: [{ role: "user", content: "hi" }], max_tokens: MAX_TOKENS, [p]: v });
            if (res.ok) accepted.push(p);
            else if (res.status === 400 || res.status === 422) rejected.push(p);
            else anomaly.push(`${p}:${res.status}`); // 401/429/5xx — not a clean param verdict
        }
        return { name, model, accepted, rejected, ...(anomaly.length ? { anomaly } : {}) };
    }
    return { name, skipped: `no model baselined${lastFail ? ` (last: ${lastFail})` : ""}` };
};

const profiles = {};
for (const p of PROVIDERS) {
    const r = await profile(p);
    profiles[r.name] = r;
    if (r.skipped) console.log(`${r.name}: skipped (${r.skipped})`);
    else console.log(`${r.name} [${r.model}]  accepted: ${r.accepted.join(", ")}  rejected: ${r.rejected.join(", ") || "-"}${r.anomaly ? "  anomaly: " + r.anomaly.join(", ") : ""}`);
}

const outPath = new URL("./capability-profiles.json", import.meta.url);
writeFileSync(outPath, JSON.stringify({
    note: "Live-probed per-provider sampling-parameter acceptance (#568). Acceptance permits transport; it does not prove semantic effect or justify a default.",
    profiles,
}, null, 2) + "\n");
console.log(`\nwrote ${Object.values(profiles).filter((p) => !p.skipped).length} profiles -> scripts/capability-profiles.json`);
