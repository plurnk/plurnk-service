# `@plurnk/plurnk-models` Specification

## §model-catalog-build Catalog snapshot and update

`@plurnk/plurnk-models` projects the upstream `@opencode-ai/models` snapshot into a read-only SQLite database (`src/catalog.db`, packaged as `dist/catalog.db` with its declarative `@possumtech/sqlrite` SQL files under `dist/sql/`) during `npm run generate` (invoked by `npm run build`). Only providers whose upstream protocol maps to a `ProviderAdapter` supported by `@plurnk/plurnk-providers` and models with a positive `limit.context` are emitted. Missing display names, capability booleans, modalities, or reasoning option descriptors fail generation. The built database is sealed in `DELETE` journal mode (`VACUUM; PRAGMA optimize;`) so immutable installations open read-only without WAL sidecars and importing `@plurnk/plurnk-models` retains no full-catalog heap snapshot.

## §model-catalog-cache Runtime refresh and disk cache

`updateCatalogCache(cachePath, options?)` fetches `https://models.dev/api.json` (sending `If-None-Match` when a cached ETag exists), projects the upstream payload through the same validator as build-time generation, writes the sealed SQLite database atomically at `cachePath` (`models.db`), and hot-swaps the active read-only `@possumtech/sqlrite` overlay (`ATTACH DATABASE` + `TEMP VIEW`) so newly released models resolve immediately without restarting the daemon. `loadCatalogCache(cachePath)` validates and overlays the cached SQLite database with the shipped `catalog.db` on startup (newer source wins on overlap) without loading either catalog into Node heap.

## §model-catalog-projection Model resolution and physics

| Function | Contract |
|---|---|
| `lookup(provider, model)` | Exact primary-key SQLite lookup in the active catalog (`ModelInfo` or `null`). Preserves independent `contextWindow`, `maxInputTokens`, `maxOutputTokens`, `reasoning`, `reasoningOptions`, `modalities`, and per-1M-token USD `cost` rates (`inputPer1M`, `outputPer1M`, `reasoningPer1M`, `cacheReadPer1M`, `cacheWritePer1M`). |
| `resolveModel(provider, model)` | Exact `lookup` first; on miss, resolves a unique `/<model>` path suffix within `provider` (`{ id, info }`), returning `null` when absent or ambiguous. |
| `lookupProvider(provider)` | Returns `ProviderInfo` (`{ id, name, adapter, env, api? }`) or `null` (`ollama` is the built-in local rail; `ollama-cloud` is the cataloged cloud provider). |
| `listProviders()` / `listCatalogProviders()` | Returns sorted `ProviderInfo` records for all cataloged providers, or only providers with at least one model row. |
| `queryCatalog(query)` | Indexed SQLite filtering, case-insensitive substring search across selector/provider name/model name, binary selector ordering, and `LIMIT`/`OFFSET` pagination without materializing the full catalog in heap. |
| `providerCredentialEnvNames()` | Returns secret credential environment variable names across cataloged providers, excluding non-secret coordinate variables (`AWS_REGION`, `AWS_DEFAULT_REGION`, `CLOUDFLARE_ACCOUNT_ID`). |
