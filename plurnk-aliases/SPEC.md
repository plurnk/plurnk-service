# @plurnk/plurnk-aliases — contract

The canonical runtime-free parser for Plurnk model selectors and the optional
model-alias cascade. Zero runtime
dependencies. `@plurnk/plurnk-providers` depends on this package and re-exports
its surface unchanged. Clients transmit selector strings and never resolve the
daemon's environment themselves; this package is the daemon/provider runtime's
single parsing authority.

## The cascade

- **`PLURNK_MODEL_<alias>=<provider>/<model>`** declares an alias. The provider
  segment is the **first** `/`-delimited field; the model id is everything after
  that first `/` (it MAY contain further `/`, e.g. `openrouter/anthropic/claude-…`).
- **`PLURNK_MODEL=<selector>`** selects either a declared alias or an exact
  `<provider>/<model>` route at boot.
- §alias-child-selector-reserved **`PLURNK_MODEL_CHILD=<selector>` is reserved as
  the child-provider selector** and is never parsed as an alias declaration. It
  accepts the same alias-or-route vocabulary.
- **`PLURNK_BASEURL_<alias>`** attaches a per-alias endpoint override — the one
  thing a per-provider base-URL var can't express (two aliases on the same
  provider name pointing at different self-hosted boxes).

Alias keys are **case-folded** (the suffix after `PLURNK_MODEL_` / `PLURNK_BASEURL_`
is downcased), so `PLURNK_MODEL_opus` and `PLURNK_MODEL_OPUS` name the same alias.

## Route types

```ts
interface ProviderSpec {
    readonly provider: string;
    readonly model: string;
    readonly alias?: string;
    readonly baseUrl?: string;
}

type ProviderAlias = ProviderSpec & { readonly alias: string };
```

This daemon-private construction shape is distinct from the client-visible
`ModelRoute`, which contains only `provider`, `model`, and optional alias
provenance. An exact provider spec omits `alias` and `baseUrl`. A declared alias
carries both its provenance and any `PLURNK_BASEURL_<alias>` override;
alias-scoped tuning applies only when that real alias is present.

## Functions

- **`parseAliasesFromEnv(env = process.env): ProviderAlias[]`** — every declared
  alias. Skips entries with an empty value or no `/` in the value.
- **`resolveModelSelector(selector, aliases): ProviderSpec | null`** — resolves a
  case-insensitive declared alias or splits one exact route at its first `/`.
- **`resolveActiveRoute(env = process.env): ProviderSpec | null`** — resolves
  `PLURNK_MODEL`, or returns `null` only when it is unset. An explicit unknown or
  malformed selector fails instead of silently disabling the provider.

## Fail-hard rules

- **Case-folding collision** — two `PLURNK_MODEL_*` keys that downcase to the
  same alias throw (`Duplicate provider alias "<alias>"`). No silent pick.
- **Dangling override** — a `PLURNK_BASEURL_*` whose alias has no matching
  `PLURNK_MODEL_*` throws (a typo, not a silent no-op).
- **Unresolved active selector** — a non-empty `PLURNK_MODEL` that is neither a
  declared alias nor a complete exact route throws.

Both are contract violations surfaced loudly, never recovered.
