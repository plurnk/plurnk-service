# @plurnk/plurnk-providers

Provider contract and adapters for PLURNK model backends.

The package includes:

- provider interfaces and normalized responses;
- an AI SDK OpenAI-compatible adapter;
- standard provider configuration;
- alias resolution and provider discovery;
- usage, cost, reasoning, grammar, and telemetry normalization.

See `SPEC.md` for the complete API and `.env.defaults` for configuration.

## Standard providers

Backends compatible with the shared transport are configured by the standard
provider table and do not require a separate package. An alias selects a
provider and model:

```dotenv
PLURNK_MODEL_fast=openai/gpt-4.1-mini
PLURNK_MODEL=fast
OPENAI_API_KEY=...
```

Provider-specific packages are appropriate when a backend requires a distinct
protocol, discovery step, authentication flow, or response normalization.

## Provider plugins

A provider plugin may use any npm scope. Declare its identity:

```json
{
  "plurnk": {
    "kind": "provider",
    "name": "acme"
  },
  "peerDependencies": {
    "@plurnk/plurnk-providers": "^1.2.0"
  }
}
```

Default-export a factory compatible with `ProviderFactory`. The factory receives
the environment, model name, and optional per-alias base URL. It returns a
`Provider` synchronously or asynchronously.

Packages using an OpenAI-compatible API should construct
`OpenAICompatProvider`; other protocols implement `Provider` directly.

The runtime-neutral `@plurnk/plurnk-providers/openai` entrypoint exports the
OpenAI-compatible provider and its Web API transport types without importing
package discovery, environment loading, or the provider registry. A consumer
with its own request facility can inject a fetch-compatible implementation per
instance:

```ts
import { OpenAICompatProvider } from "@plurnk/plurnk-providers/openai";

const provider = new OpenAICompatProvider({
  ...config,
  fetch: providerFetch,
});
```

The injected function receives the same URL, headers, body, and `AbortSignal`
as the default `globalThis.fetch`. It owns only execution of that request.
The AI SDK owns standard request shaping, response parsing, streaming, retries,
cancellation, and timeouts. PLURNK maps the SDK result into its stable provider
contract and retains only product-specific extensions and evidence that the SDK
does not expose. Vendor binding adapters and their configuration belong to the
consuming integration.

Discovery scans installed npm packages for `plurnk.kind === "provider"`.
Duplicate provider names are errors. `PLURNK_PLUGINS_TRUSTED_ONLY` can restrict
third-party discovery.

## Version compatibility

Provider plugins declare the compatible provider-framework range with normal
peer dependency semantics. `plurnk.builtAgainst` records the exact framework
version used to test the published artifact. Compatible framework patches do
not require republishing an unchanged plugin.

Do not use npm force flags to install an incompatible peer graph.

## Development

```sh
npm run test:lint -w @plurnk/plurnk-providers
npm run test:unit -w @plurnk/plurnk-providers
```
