# @plurnk/plurnk-providers

PLURNK's stable model-provider contract and its adapter to the
[AI SDK](https://ai-sdk.dev/).

Ordinary provider behavior is intentionally not reimplemented here:

- Models.dev supplies provider package, endpoint, credential, context-window,
  output-limit, and pricing metadata at build time.
- Official AI SDK providers own vendor request and response protocols.
- PLURNK owns aliases, generation envelopes, normalized usage and errors,
  evidence capture, first-party metadata, and local endpoint capabilities.

See `SPEC.md` for the contract and `.env.defaults` for every operational knob.

## Configure a model

Declare an alias, then select it:

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
or telemetry.

Discovery is scope-agnostic and rejects duplicate names.
`PLURNK_PLUGINS_TRUSTED_ONLY` restricts third-party discovery.

## Local endpoints

`openai` and `ollama` retain small in-package adapters because local operation
requires runtime facts no static catalog owns: served model, context window,
llama-server capabilities, slots, EOS token, and exact tokenization.

The `plurnk` provider retains the compatible transport because it carries
first-party attribution and loop metadata and leaves model tuning to the
endpoint.

## Development

```sh
npm run test:lint -w @plurnk/plurnk-providers
npm run test:unit -w @plurnk/plurnk-providers
```
