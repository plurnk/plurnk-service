# @plurnk/plurnk-aliases — contract

The canonical parser for the plurnk model-alias cascade. Zero runtime
dependencies. `@plurnk/plurnk-providers` depends on this package and re-exports
its surface unchanged; thin clients depend on it directly to resolve aliases
without the provider/tokenizer machinery.

## The cascade

- **`PLURNK_MODEL_<alias>=<provider>/<model>`** declares an alias. The provider
  segment is the **first** `/`-delimited field; the model id is everything after
  that first `/` (it MAY contain further `/`, e.g. `openrouter/anthropic/claude-…`).
- **`PLURNK_MODEL=<alias>`** selects the active alias at boot.
- **`PLURNK_BASEURL_<alias>`** attaches a per-alias endpoint override — the one
  thing a per-provider base-URL var can't express (two aliases on the same
  provider name pointing at different self-hosted boxes).

Alias keys are **case-folded** (the suffix after `PLURNK_MODEL_` / `PLURNK_BASEURL_`
is downcased), so `PLURNK_MODEL_opus` and `PLURNK_MODEL_OPUS` name the same alias.

## `ProviderAlias`

```ts
interface ProviderAlias {
    readonly alias: string;
    readonly provider: string;
    readonly model: string;
    readonly baseUrl?: string;  // present only when PLURNK_BASEURL_<alias> is set
}
```

## Functions

- **`parseAliasesFromEnv(env = process.env): ProviderAlias[]`** — every declared
  alias. Skips entries with an empty value or no `/` in the value.
- **`resolveActiveAlias(env = process.env): ProviderAlias | null`** — the alias
  named by `PLURNK_MODEL` (case-insensitive), or `null` when `PLURNK_MODEL` is
  unset or names no declared alias.

## Fail-hard rules

- **Case-folding collision** — two `PLURNK_MODEL_*` keys that downcase to the
  same alias throw (`Duplicate provider alias "<alias>"`). No silent pick.
- **Dangling override** — a `PLURNK_BASEURL_*` whose alias has no matching
  `PLURNK_MODEL_*` throws (a typo, not a silent no-op).

Both are contract violations surfaced loudly, never recovered.
