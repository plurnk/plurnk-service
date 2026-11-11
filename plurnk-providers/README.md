# @plurnk/plurnk-providers

Model-provider contract and transport adapters over `@earendil-works/pi-ai` and OpenAI-compatible HTTP endpoints. Native tool calling is disabled across protocols; PLURNK operations travel as text ({§provider-interface}).

- **Contract:** [`SPEC.md`](SPEC.md)
- **Model-facing reference:** [`docs/models.md`](docs/models.md)
- **Operator panel:** [`.env.defaults`](.env.defaults) (`PLURNK_PROVIDERS_ERROR_DETAIL_LIMIT` bounds upstream error detail)

## Subpaths

```js
import { aggregateProviderAccounting, estimateProviderCost } from "@plurnk/plurnk-providers/accounting";
import { ProviderError } from "@plurnk/plurnk-providers/errors";
```

Root entry composes the Node runtime, extension discovery, and `.env.defaults`; `/accounting` and `/errors` are runtime-neutral ({§provider-interface}).

## Configure a model

Run `plurnk onboard` for interactive setup, or keep route selectors in `~/.config/plurnk/.env` and credentials in the shell / `~/.config/environment.d/*.conf`:

```dotenv
# ~/.config/plurnk/.env
PLURNK_MODEL_fast=deepinfra/zai-org/GLM-5.3-Flash
PLURNK_MODEL=deepseek/deepseek-v4-flash
```

```sh
# Login shell or user service environment (never in .env)
export DEEPSEEK_API_KEY="..."
export DEEPINFRA_API_KEY="..."
```

| Form | Meaning |
| --- | --- |
| `PLURNK_MODEL=provider/model` | Select a catalog route directly. |
| `PLURNK_MODEL_<alias>=provider/model` | Declare a named alias and tuning scope (`alias` is case-insensitive). |
| `PLURNK_BASEURL_<alias>=https://endpoint/v1` | Override that alias's endpoint URL. |
| `PLURNK_PROVIDERS_<KNOB>_<alias>=value` | Per-alias override (`OUTPUT_BUDGET`, `REASONING_BUDGET`, `TEMPERATURE`, `TOP_P`, `TOP_K`, `PRESENCE_PENALTY`, `FREQUENCY_PENALTY`, `SEED`, `MAX_CONCURRENCY`, etc., {§provider-configuration}). |
| `PLURNK_PROVIDERS_PROVIDER_<NAME>_*` | Declare an uncataloged OpenAI-compatible provider (`ADAPTER`, `BASE_URL`, `API_KEY_ENV`). |

Catalog metadata ships from Models.dev and can be refreshed into `$XDG_CACHE_HOME/plurnk/models.json` via `plurnk-service update`, `plurnk update`, or `/update` ({§model-catalog-cache}). Context window, output limits, reasoning activation, and cost resolve independently ({§model-fact-resolution}, {§provider-monetary-evidence}).

### Local endpoints (`openai` / `ollama`)

```dotenv
PLURNK_MODEL_local=openai/model-name-from-endpoint
PLURNK_BASEURL_local=http://127.0.0.1:8080/v1
PLURNK_MODEL=local
# PLURNK_PROVIDERS_MAX_CONCURRENCY_local=1
```

In-package `openai` and `ollama` adapters probe live context windows, `llama-server` slots/capabilities (`PLURNK_PROVIDERS_LLAMA_SERVER_<alias>=1` pins when unprobed), EOS tokens, and exact tokenization; `think-tags` is an explicit opt-in for leading `<think>` envelopes.

## Capacity, reasoning, and runtime boundaries

| Boundary | Rule |
| --- | --- |
| Effort & reasoning budget | `adaptive` requests dynamic reasoning or falls back to `PLURNK_PROVIDERS_EFFORT_FALLBACK` (`high`); explicit fixed efforts must be route-supported. Unset reasoning budget leaves reasoning enabled. |
| Output & floor (`PLURNK_PROVIDERS_OUTPUT_FLOOR`) | Shipped `25%` floor sets the input wall (`contextWindow - floor`); packets past the output budget flex output down to the remainder ({§provider-capacity-admission}). |
| Concurrency & deadlines | Optional per-endpoint `MAX_CONCURRENCY` ({§provider-inference-admission}); one whole-call generation deadline across queueing and `Retry-After` retries. |
| Provider extensions | First-party `@plurnk/*` packages with `plurnk: { "kind": "provider", "name": "..." }` default-export `ProviderExtension` (`model(modelId)`, optional `attributions(context)`, {§extension-discovery}). |

## Live conformance & development

```sh
npm run test:lint -w @plurnk/plurnk-providers
npm run test:unit -w @plurnk/plurnk-providers
npm --prefix plurnk-core run test:live -- --specimen "<exact specimen name>"
```

Live classifications: `pass`, `auth/credential`, `transport`, `op:stable-fail`, `op:stochastic`, `unreachable`. `npm run probe:providers` runs an explicit paid diagnostic across keyed providers.
