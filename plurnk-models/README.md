# @plurnk/plurnk-models

A build-time-vendored snapshot of model metadata — **context window + per-token pricing** — sourced from [models.dev](https://models.dev/). Consumed by [plurnk-providers](https://github.com/plurnk/plurnk-providers) and clients.

## Fallback only — live data wins

This snapshot is a **last resort**, never a primary source. A backend's probed context window and a provider's fetched per-token pricing are ground truth and can change; a vendored snapshot must never shadow them — especially cost. Consumers resolve in this order:

```
env override  →  live probe / live pricing fetch  →  THIS catalog  →  null
```

The catalog only fills the gap for a known cloud model whose endpoint doesn't self-report (e.g. a relay model behind `openrouter`). A local model (`macher.gguf` on llama-server) is a deliberate **miss** — the probe owns that.

## Use

```ts
import { lookup } from "@plurnk/plurnk-models";

const info = lookup("openrouter", "anthropic/claude-sonnet-4");
// → { contextWindow: 1000000, cost: { inputPer1M: 3, outputPer1M: 15, cacheReadPer1M: 0.3, cacheWritePer1M: 3.75 } }
// miss → null
```

`provider` is the plurnk provider name (the alias-cascade segment); `model` is the provider-native id (for relays, `publisher/model`). `catalogSnapshot()` returns the whole read-only map for a client's model picker.

## Data

Pruned to the two fields plurnk uses, across plurnk's supported providers only (~620 models, ~64 KB). Four provider names diverge from models.dev's ids (`together→togetherai`, `fireworks→fireworks-ai`, `cloudflare→cloudflare-workers-ai`, `ollama→ollama-cloud`); the rest are identity.

**No network at install or runtime** — the snapshot is committed. Refresh on the release cadence:

```
npm run generate   # fetch models.dev/api.json → prune → src/catalog.json
```
