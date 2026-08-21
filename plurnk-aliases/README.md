# @plurnk/plurnk-aliases

Runtime-free parser for Plurnk model selectors and the optional alias cascade.
Vendor-agnostic, MIT.

Resolves `PLURNK_MODEL_<alias>=<provider>/<model>` env vars (plus per-alias
`PLURNK_BASEURL_<alias>` endpoint overrides) into structured `ProviderAlias`
records. `PLURNK_MODEL` may select one of those aliases or an exact
`provider/model` route. `@plurnk/plurnk-providers` depends on this package and
re-exports the same surface, keeping environment parsing separate from provider
construction. Clients send selector strings; the daemon resolves them against
its own operator environment.

## Install

```sh
npm install @plurnk/plurnk-aliases
```

Node ≥26, ESM.

## API

```ts
import { parseAliasesFromEnv, resolveActiveRoute, resolveModelSelector, type ProviderAlias, type ProviderSpec } from "@plurnk/plurnk-aliases";

parseAliasesFromEnv(env = process.env): ProviderAlias[]   // every declared alias
resolveModelSelector(selector, aliases): ProviderSpec | null // alias or exact route
resolveActiveRoute(env = process.env): ProviderSpec | null  // the PLURNK_MODEL-selected route, or null
```

```ts
interface ProviderAlias {
    readonly alias: string;     // lowercase, .env key suffix downcased
    readonly provider: string;  // "openai", "openrouter", "ollama", …
    readonly model: string;     // provider-native id; may contain "/"
    readonly baseUrl?: string;  // PLURNK_BASEURL_<alias> override, when set
}
```

To resolve a selector from a client control:

```ts
const route = resolveModelSelector(selector, parseAliasesFromEnv());
```

## Contract

The provider segment is the **first** `/`-delimited field; the model id is the
remainder (it may itself contain `/`). Aliases are case-folded. Fail-hard on a
case-folding collision (two keys → one alias) and on a `PLURNK_BASEURL_*`
override with no matching alias (a typo, never a silent no-op). Exact routes do
not manufacture aliases or gain alias-scoped tuning. See `SPEC.md`.
