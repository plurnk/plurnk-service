---
"@plurnk/plurnk-contracts": major
"@plurnk/plurnk-modules": minor
"@plurnk/plurnk-schemes": minor
"@plurnk/plurnk-skills": minor
"@plurnk/plurnk-personas": minor
"@plurnk/plurnk-schedule": minor
"@plurnk/plurnk-mcp": minor
"@plurnk/plurnk-acp": major
"@plurnk/plurnk-service": major
---

Add the in-service `service` tier across the configuration and Functionality
cascades (#1581):

- Establish one two-stage monotonic cascade (`host → service → workspace →
  session → turn`), keeping bind-time, host-confinement, and family-managed
  keys strictly host-only while narrowing ceilings monotonically and emitting
  loud `configuration_service_shadow` notices + `ConfigEntry.shadows` when
  service overrides shadow explicit host values.
- Add the dedicated client-only `config` plane (`service.config.{list,set,unset}`,
  `workspace.config.{list,set,unset}`) gated by the fail-safe
  `PLURNK_SERVICE_CLIENT_CONFIG` allowlist (advertised on
  `ApplicationDaemonPolicy.config`), isolating secrets exclusively in encrypted
  `$XDG_STATE_HOME/plurnk/config-secrets.enc` (`0600` AES-256-GCM + HKDF)
  outside SQLite and `share`, plus `plurnk-service config {set,unset}` with
  stdin secret support and `SIGHUP` live reload.
- Retire `workspace.create({ settings })` and `_meta.plurnk.settings` in favor
  of canonical `{ config?, client? }` backed by `workspace_config` (migration
  `031` migrates existing `workspaces.settings` knobs in place and renames
  persisted `"service"` Functionality origins to `"host"`).
- Rename the read-only external Functionality origin from `"service"` to
  `"host"` (`409 alias-host-owned`), and uniformly project client-only
  `service.<family>.*` actions (`mcp`, `skills`, `personas`, `env`) plus
  daemon-wide `service.mcp.oauth.{begin,complete}` with shared encrypted grants
  and client confinement on `service`-origin definitions.
