# Changelog

Notable user-visible changes will be recorded here.

This project is under active stabilization. Until a stable compatibility policy
is published, release notes may include breaking changes.

## Unreleased — the next publication after 1.16.5

Breaking for external AG-UI and RPC clients:

- The `worker://~/` alias is gone; a worker is addressed by its literal name.
- `worker.skills.*` actions are `workspace.skills.*`; Functionality is workspace-owned.
- `PLURNK_SERVICE_WORKER_WARM_*` knobs are `PLURNK_SERVICE_WORKSPACE_WARM_*`.
- `REASONING_ENCRYPTED_VALUE` is no longer emitted; the reasoning address form changed.
- `loop.inject` and `loop.cancel` never create a workspace: an unknown name is a 404
  `workspace-not-found`.
- The `BUFF` client operation left the language; a `BUFF` fence is an executor tag.
- `@plurnk/plurnk-execs` no longer exports the frozen `Advertise` helper.
- `@plurnk/plurnk-plurnkdown` is retired; the packet Markdown projection is specified in
  `plurnk-core/SPEC.md` (`§packet-markdown`).

Language and teaching:

- Executable fences, no lanes, one optional TASK disposition; unlabeled fences are literal SENDs.
- Matchers ride the heading as `[{"pattern": "…"}]` on FIND, READ, KILL, EDIT, COPY and MOVE;
  READ stays READ; node dialects replace whole regions on EDIT.
- A reply that opens with an operation heading is refused (`send-looks-like-operation`);
  delivered replies name the prompts they answered.
- READ receipts name a resource's other channels with their tokens; a fetched page's source
  is its body and its curated Markdown is `#readable`; the Tavily materializer ships by default.
- A lean `plurnk.md`, one `## Delegation` section, and a lean turn 0.

Daemon and database:

- The schema baseline is eight domain chapters; process triggers live beside the statements
  that fire them; the engine has no TX or EXEC blocks.
- Packet sections are rows over content-addressed items; whole-packet readers select from
  `turn_packets`. A database from an earlier release is recreated, not read.
- Retention is the operator's policy (`PLURNK_SERVICE_RETAIN_PACKET_*`,
  `PLURNK_SERVICE_COLLECT_*`, `PLURNK_SERVICE_RETENTION_INTERVAL_MS`); information is kept by
  default and transient data is collected.
- A worker's obligations are one view; cancellation is one bound statement; a fork is the
  claim of its branch row.

## Before 1.16.5 — notes recorded during stabilization

### Filesystem and skills

- Split user configuration and durable data across the XDG config and data
  homes. Existing pre-XDG installations move only through
  `plurnk-service paths migrate`, which refuses conflicts and verifies every
  copy before removing legacy sources.
- Discover Agent Skills from project `.agents/skills/`, user
  `~/.agents/skills/`, and the exact bundled fallback, with project-first
  precedence and no Plurnk-specific registration.
- Added `plurnk-service config`, `config edit`, `config defaults`, and
  `config check` as views over the existing environment cascade.
- Removed implicit `~/.plurnk` reads and the bespoke
  `@plurnk/plurnk-execs-skills` executor. Generated configuration references
  are now rendered on demand instead of copied into an operator home.

## 1.4.0 - 2026-08-06

### Changed

- Consolidated bundled packages into the platform monorepo.
- Added build provenance and a reproducible client-and-daemon candidate
  launcher.
- Simplified contributor guidance and architecture documentation.
- Replaced prose-to-test anchoring gates with behavioral `node:test` names.
- Standardized content regex matchers on ECMAScript `/pattern/flags` syntax.

### Removed

- Retired package hierarchy and aggregator release conventions.
- Removed obsolete architecture doctrine and duplicate planning documents.
- Removed regex target paths; targets now address exact paths or shell globs.
