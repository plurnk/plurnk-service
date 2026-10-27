# `@plurnk/plurnk-models` Specification

## §model-catalog-build Catalog snapshot and update

`@plurnk/plurnk-models` projects the upstream `@opencode-ai/models` snapshot into `src/catalog.json` and `src/providers.json` during `npm run generate` (invoked by `npm run build`). Only providers whose upstream protocol maps to a `ProviderAdapter` supported by `@plurnk/plurnk-providers` and models with a positive `limit.context` are emitted. Missing display names, capability booleans, modalities, or reasoning option descriptors fail generation.

## §model-catalog-cache Runtime refresh and disk cache

`updateCatalogCache(cachePath, options?)` fetches `https://models.dev/api.json` (sending `If-None-Match` when a cached ETag exists), projects the upstream payload through the same validator as build-time generation, writes the atomic disk cache at `cachePath`, and hot-swaps the in-memory catalog so newly released models resolve immediately without restarting the daemon. `loadCatalogCache(cachePath)` merges cached entries into the shipped snapshot on startup so cached models remain available across restarts.

## §model-catalog-projection Model resolution and physics

| Function | Contract |
|---|---|
| `lookup(provider, model)` | Exact lookup in the active catalog (`ModelInfo` or `null`). Preserves independent `contextWindow`, `maxInputTokens`, `maxOutputTokens`, `reasoning`, `reasoningOptions`, `modalities`, and per-1M-token USD `cost` rates (`inputPer1M`, `outputPer1M`, `reasoningPer1M`, `cacheReadPer1M`, `cacheWritePer1M`). |
| `resolveModel(provider, model)` | Exact `lookup` first; on miss, resolves a unique `/<model>` path suffix within `provider` (`{ id, info }`), throwing when multiple catalog ids share the suffix. |
| `lookupProvider(provider)` | Returns `ProviderInfo` (`{ id, name, adapter, env, api? }`) or `null` (`ollama` is the built-in local rail; `ollama-cloud` is the cataloged cloud provider). |
| `providerCredentialEnvNames()` | Returns secret credential environment variable names across cataloged providers, excluding non-secret coordinate variables (`AWS_REGION`, `AWS_DEFAULT_REGION`, `CLOUDFLARE_ACCOUNT_ID`). |
