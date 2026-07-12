# @plurnk/plurnk-aliases

Zero-dependency parser for the plurnk model-alias cascade. Vendor-agnostic, MIT.

Resolves `PLURNK_MODEL_<alias>=<provider>/<model>` env vars (plus per-alias
`PLURNK_BASEURL_<alias>` endpoint overrides) into structured `ProviderAlias`
records. Extracted from `@plurnk/plurnk-providers` so a **thin client** can
resolve aliases from its own always-fresh env — and send the daemon a resolved
`{ provider, model, baseUrl? }` — without pulling the provider-instantiation or
tokenizer machinery. `@plurnk/plurnk-providers` depends on this and re-exports
the same surface, so it stays the single source of truth.

## Install

```
npm install @plurnk/plurnk-aliases
```

Node ≥26, ESM.

## API

```ts
import { parseAliasesFromEnv, resolveActiveAlias, type ProviderAlias } from "@plurnk/plurnk-aliases";

parseAliasesFromEnv(env = process.env): ProviderAlias[]   // every declared alias
resolveActiveAlias(env = process.env): ProviderAlias | null // the PLURNK_MODEL-selected one, or null
```

```ts
interface ProviderAlias {
    readonly alias: string;     // lowercase, .env key suffix downcased
    readonly provider: string;  // "openai", "openrouter", "ollama", …
    readonly model: string;     // provider-native id; may contain "/"
    readonly baseUrl?: string;  // PLURNK_BASEURL_<alias> override, when set
}
```

To resolve a named alias (e.g. from `loop.run({ alias })`), parse and find:

```ts
const alias = parseAliasesFromEnv().find((a) => a.alias === name.toLowerCase());
```

## Contract

The provider segment is the **first** `/`-delimited field; the model id is the
remainder (it may itself contain `/`). Aliases are case-folded. Fail-hard on a
case-folding collision (two keys → one alias) and on a `PLURNK_BASEURL_*`
override with no matching alias (a typo, never a silent no-op). See `SPEC.md`.
