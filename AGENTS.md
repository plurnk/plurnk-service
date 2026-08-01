# PLURNK platform monorepo

Read `../POSSUMTECH.md` completely before this file. Stop if that central
contract is unavailable. This file adds only rules specific to the open-source
PLURNK platform monorepo.

This repository is an npm workspace containing the daemon
(`plurnk-core`, published as `@plurnk/plurnk-service`), the grammar, the AG-UI
server module, and the plugins included in the default installation. The
command-line client and editor integrations are separate repositories.

## Package ownership

- `plurnk-core` owns daemon lifecycle, persistence, workspaces, workers, loops,
  packet assembly, and orchestration.
- `plurnk-grammar` owns the model-facing language and its syntax schemas.
- `plurnk-contracts` owns runtime-neutral Problems, operation results, notices,
  and their wire schemas.
- `plurnk-agui` owns the external client protocol and translates between AG-UI
  and daemon operations.
- `plurnk-providers*`, `plurnk-schemes*`, `plurnk-mimetypes*`, and
  `plurnk-execs*` own their respective plugin contracts and implementations.
- `plurnk-meta` contains shared package discovery and model-facing reference
  material. It is not a second orchestration layer.

Dependencies should point from consumers to the smallest package that owns the
required contract. Do not duplicate schemas, package discovery, configuration
rules, or protocol types in another package.

See `ARCHITECTURE.md` for process boundaries and data flow. Package-level public
contracts belong in that package's `SPEC.md`; implementation notes belong near
the code they describe.

## Development

Install and test from the repository root:

```sh
npm install
npm test
```

The development runtime executes TypeScript source with Node's type stripping
and the `plurnk-dev` export condition. Published executables use `dist`.
Therefore, build before testing a binary or installed-package path:

```sh
npm run build
```

Use the root lockfile. Keep the dependency graph valid under `npm ls --all`.
Internal workspace dependencies and plugin peer dependencies use their declared
compatible semver ranges; do not force incompatible transitive versions with
root overrides.

## Monorepo contracts

- JSON Schema is authoritative for shared wire shapes.
- TypeScript types provide local ergonomics and should be generated from shared
  schemas where generation is already part of the package workflow.
- Each environment variable is documented by the package that reads it.
- Reject invalid state at the boundary that owns the contract. Recovery,
  retries, and compatibility behavior must be intentional and tested; they are
  not categorically forbidden.

## Changes

Run package-focused tests while iterating, then the root gate before publishing
or claiming repository-wide success. For client/daemon behavior, verify the
assembled built product; a source-level test does not prove that an installed
executable works.

Changes spanning packages should preserve ownership: update the schema or
contract at its owning package, then update consumers. Do not introduce
compatibility aliases, dual paths, or transitional behavior unless compatibility
is itself an agreed requirement.
