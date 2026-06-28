import test from "node:test";
import { strict as assert } from "node:assert";
import { lookup, catalogSnapshot } from "./index.ts";

test("lookup: a known cloud model resolves to context window + pricing", () => {
    const info = lookup("openrouter", "anthropic/claude-sonnet-4");
    assert.ok(info !== null, "expected a snapshot entry for a well-known relay model");
    assert.ok(info.contextWindow > 0);
    assert.equal(typeof info.cost?.inputPer1M, "number");
    assert.equal(typeof info.cost?.outputPer1M, "number");
});

test("lookup: the diverging provider names map to their models.dev ids", () => {
    // together → togetherai, fireworks → fireworks-ai, cloudflare → cloudflare-workers-ai,
    // and the Chinese hosts that diverge: moonshot → moonshotai, dashscope → alibaba,
    // zhipu → zai, hunyuan → tencent-tokenhub. Each maps onto a real provider with at
    // least one model; an identity lookup would miss.
    const snap = catalogSnapshot();
    const first = (id: string) => Object.keys(snap[id])[0];
    const mapsThrough = (name: string, id: string) => {
        assert.ok(id in snap, `${id} missing from snapshot`);
        assert.equal(lookup(name, first(id))?.contextWindow, snap[id][first(id)].contextWindow, `${name} → ${id}`);
    };
    mapsThrough("together", "togetherai");
    mapsThrough("fireworks", "fireworks-ai");
    mapsThrough("cloudflare", "cloudflare-workers-ai");
    mapsThrough("moonshot", "moonshotai");
    mapsThrough("dashscope", "alibaba");
    mapsThrough("zhipu", "zai");
    mapsThrough("hunyuan", "tencent-tokenhub");
});

test("lookup: an unknown/local model is a miss (null) — the probe owns that case", () => {
    assert.equal(lookup("openai", "macher.gguf"), null);      // local llama-server model — not in any catalog
    assert.equal(lookup("nonprovider", "whatever"), null);     // unknown provider
});

test("catalogSnapshot: only plurnk-supported providers are vendored, each non-empty", () => {
    // The vendored set = the KEEP list in generate.mjs (those models.dev actually
    // has). Asserted as a subset so a models.dev-side rename surfaces, not a bare count.
    const ALLOWED = new Set([
        "openai", "groq", "deepseek", "mistral", "togetherai", "fireworks-ai",
        "deepinfra", "openrouter", "ollama-cloud", "google", "cloudflare-workers-ai",
        "xai", "anthropic",
        "moonshotai", "alibaba", "zai", "tencent-tokenhub", "minimax", "stepfun",
        "siliconflow", "modelscope",
    ]);
    const snap = catalogSnapshot();
    const ids = Object.keys(snap);
    assert.ok(ids.length > 0);
    for (const id of ids) {
        assert.ok(ALLOWED.has(id), `unexpected vendored provider "${id}"`);
        assert.ok(Object.keys(snap[id]).length > 0, `"${id}" vendored empty`);
    }
});
