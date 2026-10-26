# Model Catalog

## §model-catalog-build Snapshot lifecycle

| Boundary | Contract |
| --- | --- |
| Source | The lockfile selects the official `@opencode-ai/models/snapshot` build-only dependency. Generation performs no network requests. |
| Development | Build generates ignored `src/catalog.json` and `src/providers.json`; neither is committed. |
| Publication | Build/prepack includes both generated catalogs in `dist`. Runtime requires neither upstream code nor network access. |
| Refresh | Update the snapshot dependency and lockfile, then rebuild and verify consumers. A build does not select a newer snapshot. |

## §model-catalog-cache On-demand XDG cache overlay

| Boundary | Contract |
| --- | --- |
| Offline boot | `loadCatalogCache(cachePath)` reads an existing cached projection without network access. On overlap between the shipped snapshot and the cache, whichever has the newer timestamp wins while entries unique to the other remain available. |
| Explicit refresh | `updateCatalogCache(cachePath)` performs a conditional `GET` (`If-None-Match` when an `ETag` is cached) against `https://models.dev/api.json`, validates the response through `projectCatalog`, writes the cache atomically, and hot-swaps the active in-memory catalog immediately. |

## §model-catalog-projection Retained facts

| Projection | Contract |
| --- | --- |
| Providers | Retain providers using supported AI SDK packages, with id, name, SDK package, credential names, and optional API URL. |
| Models | Retain models with positive context windows and valid required capability facts. Preserve independent input/output limits, reasoning controls, modalities, optional capabilities, and available rate groups. |
| Missing facts | Omit unavailable optional facts; do not infer one limit or rate from another. Invalid required facts fail generation. |
| Runtime | Read-only lookup; precedence and operator overrides belong to {§model-fact-resolution}. |
| Native ids | `resolveModel` resolves a provider-native id, or a suffix unique within that provider's catalog, to its catalog id; no PLURNK vendor table stands between. |
