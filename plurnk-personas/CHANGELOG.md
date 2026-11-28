# @plurnk/plurnk-personas

## 1.2.0

### Minor Changes

- 3d53337: Add the in-service `service` tier across the configuration and Functionality
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

### Patch Changes

- eb0293a: Advertise per-family Functionality scopes (`policy.familyScopes`), retire
  `service.schedule.*` and `service.members.*` as workspace-only families, add
  `models.providers` and `config/changed` discrete notifications for live
  provider onboarding, and isolate MCP `${NAME}` expansion from daemon provider
  credentials and `PLURNK_*` secrets (#1588).
- 9d04649: Bound transient in-memory caches and reclaim memory on workspace cooling and
  retention sweeps: evict `MembershipMaterialization` settled-stat caches and run
  `PRAGMA shrink_memory` in `WorkspaceResidency` and `Retention`, LRU-bound
  cold-workspace persona reads and `llms.txt` origin attempts, evict archived or
  empty workspaces from `Scheduler` RAM, clean up `#configurationNotices` on MCP
  teardown, switch `_search-exclusion` to a single-entry cache, and add a
  repeatable `npm run bench:memory` footprint benchmark (#1579).
- Updated dependencies [eb0293a]
- Updated dependencies [12055f7]
- Updated dependencies [9319f97]
- Updated dependencies [1f24586]
- Updated dependencies [3d53337]
  - @plurnk/plurnk-contracts@11.0.0

## 1.1.0

### Minor Changes

- 8032dbd: Enforce unified physical `realpath` containment for local project-scoped skill
  and persona sources (`path-containment.ts` in `@plurnk/plurnk-meta`), and
  advertise registered Functionality `families` in `daemonPolicy()` (#1567, #1569).

### Patch Changes

- Updated dependencies [f4c6ae9]
- Updated dependencies [8032dbd]
  - @plurnk/plurnk-meta@4.1.0

## 1.0.0

> Bare `#N` issue citations reference our development forge rather than GitHub issues; open bug reports and questions on [GitHub issues](https://github.com/plurnk/plurnk-service/issues).

### Major Changes

- Initial release: workspace persona discovery (`PERSONA.md`), Functionality
  family (`workspace.personas.*`), and `persona://` resource trees over shared
  `@plurnk/plurnk-agent-skills` primitives (`#1559`).
- Dependencies:
  - `@plurnk/plurnk-agent-skills@^2.1.0`
  - `@plurnk/plurnk-meta@^4.0.0`
  - `@plurnk/plurnk-contracts@^10.0.0`
  - `@plurnk/plurnk-modules@^5.0.0`
  - `@plurnk/plurnk-schemes@^3.0.0`
