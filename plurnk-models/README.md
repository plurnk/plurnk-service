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
//     maxOutput: 64_000,
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

## Refresh

The committed snapshot is refreshed deliberately at release time:

```sh
npm run generate
```

That command fetches `https://models.dev/api.json`, retains providers whose AI
SDK package PLURNK supports, prunes the model facts, and rewrites the two source
JSON files.
