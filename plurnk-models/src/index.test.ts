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

test("lookup: the four diverging provider names map to their models.dev ids", () => {
    // together → togetherai, fireworks → fireworks-ai, cloudflare → cloudflare-workers-ai.
    // Each maps onto a real provider with at least one model; an identity lookup would miss.
    const snap = catalogSnapshot();
    assert.ok("togetherai" in snap && "fireworks-ai" in snap && "cloudflare-workers-ai" in snap);
    const first = (id: string) => Object.keys(snap[id])[0];
    assert.equal(lookup("together", first("togetherai"))?.contextWindow, snap["togetherai"][first("togetherai")].contextWindow);
    assert.equal(lookup("fireworks", first("fireworks-ai"))?.contextWindow, snap["fireworks-ai"][first("fireworks-ai")].contextWindow);
});

test("lookup: an unknown/local model is a miss (null) — the probe owns that case", () => {
    assert.equal(lookup("openai", "macher.gguf"), null);      // local llama-server model — not in any catalog
    assert.equal(lookup("nonprovider", "whatever"), null);     // unknown provider
});

test("catalogSnapshot: only plurnk-supported providers are vendored, each non-empty", () => {
    const snap = catalogSnapshot();
    const ids = Object.keys(snap);
    assert.ok(ids.length > 0 && ids.length <= 13);             // pruned to our supported set
    for (const id of ids) assert.ok(Object.keys(snap[id]).length > 0);
});
