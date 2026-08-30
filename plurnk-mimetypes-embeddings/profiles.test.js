import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveEmbeddingProfile } from "./profiles.js";

describe("embedding profiles ({§mimetype-embedding-profile})", () => {
    it("pins the Cloudflare Qwen route without provider-specific execution code", () => {
        const profile = resolveEmbeddingProfile({
            provider: "cloudflare-workers-ai",
            model: "@cf/qwen/qwen3-embedding-0.6b",
        }, {});
        assert.equal(profile.dimensions, 1024);
        assert.equal(profile.contextWindow, 8192);
        assert.equal(profile.maxEmbeddingsPerCall, 1);
        assert.equal(profile.tokenizerModel, "Qwen/Qwen3-Embedding-0.6B");
        assert.equal(profile.tokenizerFamily, "qwen3embed06");
        assert.equal(profile.tokenizerId, "def76fb086971c78");
        assert.equal(profile.pooling, "last-token");
        assert.equal(profile.normalization, "l2");
        assert.equal(profile.document("passage"), "passage");
        assert.equal(
            profile.query("question"),
            "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:question",
        );
        assert.match(profile.modelIdentity, /^cloudflare-workers-ai\/@cf\/qwen\/qwen3-embedding-0\.6b@[0-9a-f]{16}$/);
    });

    it("gives an upstream Qwen model the same role policy on a custom provider", () => {
        const profile = resolveEmbeddingProfile({
            provider: "local",
            model: "Qwen/Qwen3-Embedding-0.6B",
        }, {});
        assert.equal(profile.dimensions, 1024);
        assert.notEqual(profile.query("same"), profile.document("same"));
    });

    it("pins each published hosted route's vector and admission facts", () => {
        for (const [provider, model, dimensions, contextWindow, maxEmbeddingsPerCall, tokenizerModel, pooling] of [
            ["cloudflare-workers-ai", "@cf/qwen/qwen3-embedding-0.6b", 1024, 8192, 1, "Qwen/Qwen3-Embedding-0.6B", "last-token"],
            ["fireworks-ai", "accounts/fireworks/models/qwen3-embedding-0p6b", 1024, 32768, 1, "Qwen/Qwen3-Embedding-0.6B", "last-token"],
            ["fireworks-ai", "accounts/fireworks/models/qwen3-embedding-8b", 4096, 40960, 1, "Qwen/Qwen3-Embedding-8B", "last-token"],
            ["openrouter", "qwen/qwen3-embedding-8b", 4096, 32768, 1, "Qwen/Qwen3-Embedding-8B", "last-token"],
            ["openai", "text-embedding-3-small", 1536, 8191, 36, "cl100k", "provider"],
        ]) {
            const profile = resolveEmbeddingProfile({ provider, model }, {});
            assert.deepEqual(
                [profile.dimensions, profile.contextWindow, profile.maxEmbeddingsPerCall, profile.tokenizerModel, profile.pooling],
                [dimensions, contextWindow, maxEmbeddingsPerCall, tokenizerModel, pooling],
                `${provider}/${model}`,
            );
        }
    });

    it("gives the bundled MiniLM model a built-in profile on any provider, counting with the bundled vocabulary", () => {
        for (const provider of ["local-embed", "plurnk-embed"]) {
            const profile = resolveEmbeddingProfile({ provider, model: "sentence-transformers/all-MiniLM-L6-v2" }, {});
            assert.deepEqual(
                [profile.dimensions, profile.contextWindow, profile.maxEmbeddingsPerCall, profile.tokenizerModel, profile.pooling, profile.normalization],
                [384, 510, 32, "sentence-transformers/all-MiniLM-L6-v2", "provider", "provider"],
                provider,
            );
            assert.equal(profile.query("same"), profile.document("same"), `${provider}: no role transformation`);
            // model/model.sha256 — the served copy tokenizes exactly like the bundled runtime.
            assert.equal(profile.tokenizerId, "da0e79933b9ed517");
        }
        assert.throws(
            () => resolveEmbeddingProfile({ provider: "local-embed", model: "sentence-transformers/all-MiniLM-L6-v2" }, { PLURNK_EMBEDDING_DIMENSIONS: "384" }),
            /built-in embedding profile; remove duplicate operator facts: PLURNK_EMBEDDING_DIMENSIONS/,
        );
    });

    it("requires complete symmetric facts for an unknown route", () => {
        assert.throws(
            () => resolveEmbeddingProfile({ provider: "local", model: "private-embedder" }, {}),
            /PLURNK_EMBEDDING_DIMENSIONS/,
        );
        const profile = resolveEmbeddingProfile(
            { provider: "local", model: "private-embedder" },
            {
                PLURNK_EMBEDDING_DIMENSIONS: "7",
                PLURNK_EMBEDDING_CONTEXT_WINDOW: "99",
                PLURNK_EMBEDDING_TOKENIZER: "bert",
                PLURNK_EMBEDDING_MAX_INPUTS_PER_REQUEST: "7",
            },
        );
        assert.equal(profile.query("same"), profile.document("same"));
        assert.equal(profile.dimensions, 7);
        assert.equal(profile.contextWindow, 99);
        assert.equal(profile.maxEmbeddingsPerCall, 7);
        assert.equal(profile.tokenizerFamily, undefined);
        assert.equal(profile.tokenizerId, undefined);
        assert.equal(profile.pooling, "provider");
        assert.equal(profile.normalization, "provider");
    });

    it("rejects duplicate facts for a known route", () => {
        assert.throws(
            () => resolveEmbeddingProfile(
                { provider: "openrouter", model: "qwen/qwen3-embedding-8b" },
                { PLURNK_EMBEDDING_DIMENSIONS: "4096" },
            ),
            /built-in embedding profile.*PLURNK_EMBEDDING_DIMENSIONS/,
        );
    });

    it("changes vector identity when any route or profile fact changes", () => {
        const left = resolveEmbeddingProfile(
            { provider: "local-a", model: "custom" },
            {
                PLURNK_EMBEDDING_DIMENSIONS: "7",
                PLURNK_EMBEDDING_CONTEXT_WINDOW: "99",
                PLURNK_EMBEDDING_TOKENIZER: "bert",
                PLURNK_EMBEDDING_MAX_INPUTS_PER_REQUEST: "7",
            },
        );
        const right = resolveEmbeddingProfile(
            { provider: "local-a", model: "custom" },
            {
                PLURNK_EMBEDDING_DIMENSIONS: "7",
                PLURNK_EMBEDDING_CONTEXT_WINDOW: "100",
                PLURNK_EMBEDDING_TOKENIZER: "bert",
                PLURNK_EMBEDDING_MAX_INPUTS_PER_REQUEST: "7",
            },
        );
        assert.notEqual(left.modelIdentity, right.modelIdentity);
    });

    it("keeps transport batch policy out of vector-space identity", () => {
        const base = {
            PLURNK_EMBEDDING_DIMENSIONS: "7",
            PLURNK_EMBEDDING_CONTEXT_WINDOW: "99",
            PLURNK_EMBEDDING_TOKENIZER: "bert",
        };
        const singleton = resolveEmbeddingProfile(
            { provider: "local-a", model: "custom" },
            { ...base, PLURNK_EMBEDDING_MAX_INPUTS_PER_REQUEST: "1" },
        );
        const batched = resolveEmbeddingProfile(
            { provider: "local-a", model: "custom" },
            { ...base, PLURNK_EMBEDDING_MAX_INPUTS_PER_REQUEST: "32" },
        );
        assert.notEqual(singleton.maxEmbeddingsPerCall, batched.maxEmbeddingsPerCall);
        assert.equal(singleton.modelIdentity, batched.modelIdentity);
    });
});
