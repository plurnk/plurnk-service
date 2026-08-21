# @plurnk/plurnk-providers

PLURNK's stable model-provider contract and its adapter to the
[AI SDK](https://ai-sdk.dev/).

Ordinary provider behavior is intentionally not reimplemented here:

- A release-time Models.dev snapshot supplies provider package, endpoint, and
  credential names, plus context-window, output-limit, reasoning-capability,
  and pricing metadata.
- Official AI SDK providers own vendor request and response protocols.
- PLURNK owns aliases, generation envelopes, normalized usage and errors,
  evidence capture, first-party metadata, and local endpoint capabilities.

See `SPEC.md` for the contract and `.env.defaults` for every operational knob.
The package-owned `PLURNK_PROVIDERS_ERROR_DETAIL_LIMIT` bounds upstream
diagnostic text in public provider Problems.

Model facts do not share one fallback chain. Context windows, output envelopes,
reasoning activation, and estimated prices resolve independently
({§model-fact-resolution}). PLURNK does not fetch live per-token prices, and the
local estimate is not an authoritative relay-settled charge.

## Runtime-neutral contracts

Browser and edge Workers import accounting and normalized failures through
their dedicated runtime-neutral subpaths
({§provider-runtime-neutral-accounting}, {§provider-runtime-neutral-errors}):

```js
import {
  aggregateProviderAccounting,
  estimateProviderCost,
} from "@plurnk/plurnk-providers/accounting";
import { ProviderError } from "@plurnk/plurnk-providers/errors";
```

The package root composes the complete Node provider runtime, including plugin
discovery and environment-file defaults.

## Configure a model

Select a catalog route directly:

```dotenv
PLURNK_MODEL=google/gemini-3-flash
GEMINI_API_KEY=...
```

Declare an alias when the route needs a reusable name or scoped tuning:

```dotenv
PLURNK_MODEL_fast=openai/gpt-5-mini
PLURNK_MODEL=fast
OPENAI_API_KEY=...
```

Cataloged providers need no endpoint declaration. To add an
OpenAI-compatible provider that Models.dev does not describe:

```dotenv
PLURNK_PROVIDERS_PROVIDER_ACME_NPM=@ai-sdk/openai-compatible
PLURNK_PROVIDERS_PROVIDER_ACME_BASE_URL=https://api.acme.example/v1
PLURNK_PROVIDERS_PROVIDER_ACME_API_KEY_ENV=ACME_API_KEY
PLURNK_MODEL_acme=acme/model-id
```

Provider declarations are configuration, not secrets. Secret values remain in
the operator environment.

## Provider plugins

Most integrations should use an MCP server, executor, scheme, or a provider
declaration. A provider plugin is only needed for a protocol binding unavailable
through the catalog and installed SDK packages.

It may use any npm scope. Its package manifest declares the PLURNK name:

```json
{
  "plurnk": {
    "kind": "provider",
    "name": "acme"
  },
  "peerDependencies": {
    "@plurnk/plurnk-providers": "^1.2.0",
    "ai": "^6.0.0"
  }
}
```

The default export is an AI SDK provider with
`languageModel(modelId)`. PLURNK adapts that language model into its own
contract, so plugins do not reproduce retries, usage normalization, envelopes,
notices, or RFC 9457 failure normalization.

The manifest may declare always-on `plurnk.attribution`. The default export may
also implement synchronous `attributions(context)` and decide per provider
attempt whether to return no, one, or many additional opaque tags
({§plugin-attribution}).

Discovery is scope-agnostic and rejects duplicate names.
Third-party discovery uses the shared pre-import trust contract ({§plugin-trust-boundary}).

## Local endpoints

`openai` and `ollama` retain small in-package adapters because local operation
requires runtime facts no static catalog owns: served model, context window,
llama-server capabilities, slots, EOS token, and exact tokenization.

The `plurnk` provider retains the compatible transport because it carries
first-party attribution and loop metadata and leaves model tuning to the
endpoint.

## Configured-provider packet conformance matrix

Every configured model alias is exercised through a real PLURNK loop — the
production packet, a model-selected operation, its materialized result, and
completion — never a transport-only completion. Provider-exposed reasoning must
survive in the durable assistant packet and digest; a provider with no private
reasoning is valid when the observable operation cycle succeeds.

One specimen at a time, deterministically:

```sh
cd plurnk-core
npm run test:live:specimen -- "<test-name-pattern>"
```

The selector inserts `--test-name-pattern` before the expanded live file list in
the exact standard `test:live` invocation; trailing npm arguments alone cannot
narrow the suite. This procedure is `plurnk-core`'s own; the ledger below is
maintained with the evidence for every alias it names.

### Classifications

| Class | Meaning |
|---|---|
| pass | Full packet cycle completed; durable packet and digest verified |
| auth/credential | The route is blocked before the model by authorization or credential handling |
| transport | The route fails at a transport/capability boundary, not the model |
| op:stable-fail | An operation-level failure repeated on replay; assertion unweakened |
| op:stochastic | An operation-level failure did not repeat on a later roll |
| unreachable | The endpoint cannot be reached from this machine |

Authorization and credential failures are reported as their own class, never as
model failures. Repeated stochastic and stable operation failures are reported
separately in the ledger's specimens.

### Ledger

| Alias | Route (snapshot) | Class | Evidence |
|---|---|---|---|
| 38 configured aliases — 2026-07 sweep | — | 20 × pass; 14 × auth/credential/transport; 4 × operation-level | Initial READ line-slice sweep (`#7`) |
| `cfgpt120b`, `grok` | — | op:stochastic → pass on replay | `#7` |
| `cfkimi27`, `kimi` | — | op:stable-fail (unresolved, unweakened assertion) | `#7` |
| `cfds1` | `cloudflare/@cf/deepseek-ai/deepseek-r1-distill-qwen-32b` | op:stable-fail — READ repeated 13 turns to the 508 strike threshold; retrieval materialization verified (`2:beta` present, exact 409 recovery given) | `/home/hyzen/benchmarks/live-contract-read-L-TIgart/digest/` (`#7`) |

The full current classifications of every configured alias are refreshed by the
frozen-candidate live drill's honest reporting; this ledger is the maintained
record of that procedure, never a substitute for it.

## Development

```sh
npm run test:lint -w @plurnk/plurnk-providers
npm run test:unit -w @plurnk/plurnk-providers
```

`npm run test:providersPing` is an explicit paid diagnostic; it calls each
keyed provider once and prints the retained sanitized evidence directory.
