# `@plurnk/plurnk-aliases` Specification

Runtime-free parser for PLURNK model selectors and the model-alias environment cascade.

## §alias-declaration Alias declaration

Model aliases and active selectors are declared in the environment (`Record<string, string | undefined>`):

| Variable | Form | Contract |
|---|---|---|
| `PLURNK_MODEL_<alias>` | `<provider>/<model>` | Declares a reusable route under `<alias>`. `<provider>` is any non-empty segment before the first `/`; `<model>` is the non-empty remainder after the first `/` and may contain `/` (`openrouter/openai/gpt-5`). |
| `PLURNK_BASEURL_<alias>` | Absolute HTTP(S) URL | Optional per-alias endpoint override paired with `PLURNK_MODEL_<alias>`. |
| `PLURNK_MODEL` | `<alias>` or `<provider>/<model>` | Selects the active root route. Empty or whitespace-only values mean unset. |
| `PLURNK_CHILD_MODEL` | Reserved | Rejected by `parseAliasesFromEnv` so child routing flows through explicit invocation or parent inheritance. |

Alias names match `/^[a-zA-Z0-9_-]+$/` and normalize to lowercase.

## §alias-parse Selector resolution

| Entry point | Input | Resolution |
|---|---|---|
| `parseAliasesFromEnv(env)` | Environment map | Validates all `PLURNK_MODEL_*` and `PLURNK_BASEURL_*` keys, rejecting case-folding collisions (`PLURNK_MODEL_fast` and `PLURNK_MODEL_FAST`), malformed routes, reserved `PLURNK_CHILD_MODEL`, and dangling `PLURNK_BASEURL_<alias>` overrides with no matching `PLURNK_MODEL_<alias>`. |
| `resolveModelSelector(selector, aliases)` | Trimmed selector string | Resolves an exact `<provider>/<model>` route when the selector contains `/`, or looks up the lowercased alias in `aliases`. Throws a named error listing declared aliases when an alias is unknown. |
| `resolveActiveRoute(env)` | Environment map | Parses `aliases` and resolves `PLURNK_MODEL`, returning `{ route, spec, aliases }` or `null` when `PLURNK_MODEL` is unset. |
| `resolveChildRoute(childSelector, parentSpec, aliases)` | Optional child selector + parent `ProviderSpec` | Resolves `childSelector` against `aliases` when present, or inherits `parentSpec` when omitted. |

`ModelRoute` (`{ alias?, provider, model }`) is the wire-safe projection; `ProviderSpec` (`ModelRoute & { baseUrl? }`) is the daemon-internal construction identity.
