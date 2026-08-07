# Changelog

Notable user-visible changes will be recorded here.

This project is under active stabilization. Until a stable compatibility policy
is published, release notes may include breaking changes.

## Unreleased

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
