---
"@plurnk/plurnk-modules": minor
"@plurnk/plurnk-providers": minor
"@plurnk/plurnk-service": minor
---

Add opt-in outbound model-call attribution HTTP headers (`X-Plurnk-*`) via
`PLURNK_PROVIDERS_ATTRIBUTION_HEADERS` and
`PLURNK_PROVIDERS_PROVIDER_<NAME>_ATTRIBUTION_HEADERS`, plus a
`ProviderMetadataSeam` (`registerProviderMetadataContributor`) in
`@plurnk/plurnk-modules` projecting sanitized `X-Plurnk-Meta-*` headers on
routes opting into `module` (#1573).
