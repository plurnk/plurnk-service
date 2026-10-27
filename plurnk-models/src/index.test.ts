import test from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    catalogSnapshot,
    loadCatalogCache,
    lookup,
    lookupProvider,
    providerCatalogSnapshot,
    providerCredentialEnvNames,
    providerNameFromCatalogId,
    resetCatalog,
    resolveModel,
    updateCatalogCache,
} from "./index.ts";

test("{§model-catalog-projection} lookup: a known cloud model exposes the independent limits and rate groups", () => {
    const info = lookup("openai", "gpt-5.4");
    assert.ok(info !== null, "expected a snapshot entry for a well-known relay model");
    assert.equal(info.name, "GPT-5.4");
    assert.ok(info.contextWindow > 0);
    assert.ok((info.maxInputTokens ?? 0) > 0);
    assert.ok((info.maxOutputTokens ?? 0) > 0);
    assert.equal(info.reasoning, true);
    assert.equal(typeof info.cost?.inputPer1M, "number");
    assert.equal(typeof info.cost?.outputPer1M, "number");
    assert.deepEqual(info.modalities?.output, ["text"]);
    assert.equal(typeof info.toolCall, "boolean");
    assert.equal(typeof info.structuredOutput, "boolean");
});

test("{§model-catalog-projection} lookup: route-specific reasoning controls survive the Models.dev projection", () => {
    const info = lookup("cloudflare-workers-ai", "@cf/qwen/qwen3.8-27b");
    assert.ok(info !== null);
    assert.deepEqual(info.reasoningOptions, [
        { type: "toggle" },
        { type: "effort", values: ["low", "medium", "xhigh"] },
    ]);
});

test("{§model-catalog-projection} the segment IS the Models.dev id", () => {
    const snap = catalogSnapshot();
    const first = (id: string) => Object.keys(snap[id])[0];
    for (const id of ["togetherai", "fireworks-ai", "cloudflare-workers-ai", "moonshotai", "alibaba", "zai", "tencent-tokenhub", "amazon-bedrock"]) {
        assert.ok(id in snap, `${id} missing from snapshot`);
        assert.equal(lookup(id, first(id))?.contextWindow, snap[id][first(id)].contextWindow, id);
    }
    // `ollama` names the built-in local rail, which has no catalog id; the cloud catalog is ollama-cloud.
    assert.equal(lookupProvider("ollama"), null);
    assert.notEqual(lookupProvider("ollama-cloud"), null);
});

test("{§model-catalog-projection} lookup: an unknown/local model is a miss (null) — the probe owns that case", () => {
    assert.equal(lookup("openai", "macher.gguf"), null);      // local llama-server model — not in any catalog
    assert.equal(lookup("nonprovider", "whatever"), null);     // unknown provider
});

test("{§model-catalog-projection} resolveModel: a unique provider-native suffix resolves to its catalog id", () => {
    // The fixture derives from the catalog: Models.dev retires ids, and a literal rots.
    const fireworks = Object.keys(catalogSnapshot()["fireworks-ai"]);
    const native = fireworks.find((id) => id.startsWith("accounts/fireworks/models/")
        && fireworks.filter((other) => other.endsWith(`/${id.split("/").at(-1)}`)).length === 1)!;
    const resolved = resolveModel("fireworks-ai", native.split("/").at(-1)!);
    assert.equal(resolved?.id, native);
});

test("{§model-catalog-projection} provider catalog carries Models.dev's adapter construction facts", () => {
    assert.deepEqual(lookupProvider("google"), providerCatalogSnapshot().google);
    assert.equal(lookupProvider("google")?.name, "Google");
    assert.equal(lookupProvider("google")?.adapter, "google");
    assert.ok(lookupProvider("google")?.env.includes("GEMINI_API_KEY"));
    assert.equal(lookupProvider("cloudflare-workers-ai")?.id, "cloudflare-workers-ai");
});

test("{§model-catalog-projection} providerNameFromCatalogId projects the one canonical PLURNK route segment", () => {
    assert.equal(providerNameFromCatalogId("fireworks-ai"), "fireworks-ai");
    assert.equal(providerNameFromCatalogId("google"), "google");
});

test("{§model-catalog-projection} lookup: reasoning rates remain distinct from ordinary output rates", () => {
    const snap = catalogSnapshot();
    const model = Object.values(snap)
        .flatMap((models) => Object.values(models))
        .find((candidate) => candidate.cost?.reasoningPer1M !== undefined
            && candidate.cost.reasoningPer1M !== candidate.cost.outputPer1M);
    assert.ok(model !== undefined, "expected Models.dev to contain a distinct reasoning rate");
});

test("{§model-catalog-projection} provider credential names exclude non-secret endpoint coordinates", () => {
    const names = providerCredentialEnvNames();
    assert.ok(names.includes("OPENAI_API_KEY"));
    assert.ok(names.includes("AWS_SECRET_ACCESS_KEY"));
    assert.equal(names.includes("AWS_REGION"), false);
    assert.equal(names.includes("CLOUDFLARE_ACCOUNT_ID"), false);
});

test("{§model-catalog-projection} catalogSnapshot: every vendored provider has models with usable context", () => {
    const snap = catalogSnapshot();
    const providers = providerCatalogSnapshot();
    const ids = Object.keys(snap);
    assert.ok(ids.length > 0);
    for (const id of ids) {
        assert.ok(providers[id] !== undefined, `provider facts missing for "${id}"`);
        assert.ok(Object.keys(snap[id]).length > 0, `"${id}" vendored empty`);
        for (const model of Object.values(snap[id])) {
            assert.equal(
                model.reasoningOptions !== undefined,
                model.reasoning,
                `${id}/${model.name} reasoning controls must accompany the capability fact`,
            );
        }
    }
});

test("{§model-catalog-cache} updateCatalogCache writes an ETag-aware XDG cache, hot-swaps in memory, and loadCatalogCache merges newer-wins", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-models-cache-"));
    const cachePath = join(dir, "models.json");
    try {
        let seenIfNoneMatch: string | null = null;
        const payload = {
            anthropic: {
                id: "anthropic",
                name: "Anthropic",
                npm: "@ai-sdk/anthropic",
                env: ["ANTHROPIC_API_KEY"],
                models: {
                    "claude-yesterday-1": {
                        name: "Claude Yesterday 1",
                        limit: { context: 500_000, output: 64_000 },
                        attachment: true,
                        reasoning: true,
                        reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
                        tool_call: true,
                        modalities: { input: ["text", "image"], output: ["text"] },
                        cost: { input: 2, output: 10 },
                    },
                },
            },
        };

        const report1 = await updateCatalogCache(cachePath, {
            url: "https://models.dev/api.json",
            fetch: async (_input, init) => {
                const headers = new Headers(init?.headers);
                seenIfNoneMatch = headers.get("if-none-match");
                return new Response(JSON.stringify(payload), {
                    status: 200,
                    headers: { "content-type": "application/json", etag: '"v1"' },
                });
            },
        });
        assert.equal(seenIfNoneMatch, null);
        assert.equal(report1.status, "updated");
        assert.equal(report1.addedModels, 1);
        assert.equal(lookup("anthropic", "claude-yesterday-1")?.contextWindow, 500_000);
        assert.ok(lookup("openai", "gpt-5.4") !== null, "shipped models remain available");

        const report2 = await updateCatalogCache(cachePath, {
            url: "https://models.dev/api.json",
            fetch: async (_input, init) => {
                const headers = new Headers(init?.headers);
                seenIfNoneMatch = headers.get("if-none-match");
                return new Response(null, { status: 304 });
            },
        });
        assert.equal(seenIfNoneMatch, '"v1"');
        assert.equal(report2.status, "unchanged");
        assert.equal(report2.addedModels, 0);

        resetCatalog();
        assert.equal(lookup("anthropic", "claude-yesterday-1"), null);
        assert.equal(loadCatalogCache(cachePath), true);
        assert.equal(lookup("anthropic", "claude-yesterday-1")?.contextWindow, 500_000);
        // Touch shipped catalog mtime doesn't erase unique cached models even when shipped is newer
        const past = new Date(0);
        await utimes(cachePath, past, past);
        assert.equal(loadCatalogCache(cachePath), true);
        assert.equal(lookup("anthropic", "claude-yesterday-1")?.contextWindow, 500_000);
    } finally {
        resetCatalog();
        await rm(dir, { recursive: true, force: true });
    }
});

