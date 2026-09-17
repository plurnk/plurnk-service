# @plurnk/plurnk-models

A release-time snapshot of provider and model metadata from
[Models.dev](https://models.dev/). `@plurnk/plurnk-providers` uses it to
construct cataloged providers and resolve model facts without a Models.dev
request during installation or runtime. Clients may use the same snapshot for
model discovery.

## Data

The generated snapshot retains only the facts PLURNK consumes:

| Lookup             | Snapshot facts                                                         |
| ------------------ | ---------------------------------------------------------------------- |
| `lookupProvider()` | Provider id, AI SDK package, credential names, and optional API URL.   |
| `lookup()`         | Context window, optional output limit, reasoning flag, and USD prices. |

Model entries without a positive context window are omitted. `reasoning: true`
means the source asserted that capability; absence does not activate or disable
runtime reasoning. A missing cost means Models.dev supplied no complete
input/output rate pair.

```ts
import { lookup } from "@plurnk/plurnk-models";

const info = lookup("openrouter", "anthropic/claude-sonnet-4");
// → {
//     contextWindow: 1_000_000,
//     maxOutputTokens: 64_000,
//     reasoning: true,
//     cost: {
//       inputPer1M: 3,
//       outputPer1M: 15,
//       cacheReadPer1M: 0.3,
//       cacheWritePer1M: 3.75,
//     },
//   }
// miss → null
```

`provider` is the PLURNK provider name. `model` is the provider-native id; for
relays this is commonly `publisher/model`. `resolveModel()` also accepts an
unambiguous provider-native suffix. `catalogSnapshot()` and
`providerCatalogSnapshot()` expose the complete read-only maps.

## Resolution boundary

This package owns snapshot generation and lookup, not runtime precedence.
Context windows, output envelopes, reasoning activation, and prices resolve by
different rules in the provider contract ({§model-fact-resolution}). In
particular, PLURNK does not fetch live per-token prices.

## Build and refresh

The lockfile selects Models.dev's official
[`@opencode-ai/models/snapshot`](https://github.com/anomalyco/models.dev/tree/dev/packages/sdk#snapshot)
as a build-only dependency. Normal build and prepack generate the pruned source
JSON and include it in `dist`; generated JSON stays out of Git. Generation
works offline after dependency installation, and consumers need no upstream SDK.

To refresh the catalog from the repository root:

```sh
npm install --save-dev @opencode-ai/models@latest --workspace plurnk-models --no-audit --no-fund
npm run build --workspace plurnk-models
npm test --workspace plurnk-models
```

Commit the dependency/lockfile change, not the generated catalogs. `npm run
generate --workspace plurnk-models` regenerates from the already installed
snapshot without selecting a newer version. See {§model-catalog-build} and
{§model-catalog-projection}.
