# Changelog

Notable user-visible changes will be recorded here.

This project is under active stabilization. Until a stable compatibility policy
is published, release notes may include breaking changes.

## Unreleased

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
