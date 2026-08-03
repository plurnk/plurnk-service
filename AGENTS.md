# PLURNK platform monorepo

Read `../POSSUMTECH.md` completely before this file. Stop if that central
contract is unavailable. This file adds only rules specific to the open-source
PLURNK platform monorepo.

This repository is an npm workspace containing the daemon
(`plurnk-core`, published as `@plurnk/plurnk-service`), the contracts and
grammar authority, the AG-UI server module, and the plugins included in the default installation. The
command-line client and editor integrations are separate repositories.

## Package ownership

- `plurnk-core` owns daemon lifecycle, persistence, workspaces, workers, loops,
  packet assembly, and orchestration.
- `plurnk-contracts` owns the model-facing language, parser and AST, generated
  GBNF rail, shared types and schemas, runtime-neutral Problems, operation
  results, Notices, and text coordinates.
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
- **No Migrations Yet.** Until the operator explicitly ends the pre-migration
  phase, SQLite has one version-1 baseline defining the complete current schema.
  Schema changes edit that baseline and disposable development databases are
  deleted and recreated. Do not add incremental migrations, compatibility
  transforms, data backfills, or upgrade-path coverage during this phase.
- Each environment variable is documented by the package that reads it.
- Reject invalid state at the boundary that owns the contract. Recovery,
  retries, and compatibility behavior must be intentional and tested; they are
  not categorically forbidden.

## Contract references and documentation hygiene

- The owning package's `SPEC.md` states stable current behavior. Give every
  referenceable invariant, boundary, or diagram a durable named tag. Named
  specification tags use one repository-wide syntax:

  | Use | Form | Rule |
  |-----|------|------|
  | Declaration | `§lowercase-kebab` | Exactly one at the first semantic position of a `SPEC.md` heading, paragraph, list item, or table row. |
  | Citation | `{§lowercase-kebab}` | Required everywhere outside the declaring block, including other specifications, code, coverage, and diagnostics. |
  | Presentation | `§3`, `§3.bis` | Numeric document navigation is not a named contract tag. |

  Fenced, inline, and indented code examples are inert. Keep declarations
  globally unambiguous and do not silently reuse one for different semantics.
  A declaration must share its Markdown block with the contract it names; a
  tag-only block is invalid.
- Forge issues record observations, investigation, competing interpretations,
  rulings, rejected alternatives, and completion evidence. Issue numbers are
  provenance; specification tags are current authority.
- Give every new forge issue one appropriate Conventional type label when the
  issue is created; labels are part of issue creation, not later cleanup.
- README material teaches concise usage derived from the specification. Do not
  turn specifications or READMEs into chronological design journals.
- Code and coverage may cite the owning specification tag and issue numbers, but must not
  duplicate the specification's architectural explanation or retain historical
  essays. Keep only genuinely local implementation constraints near code.
- Every named specification-tag citation must resolve to one declaration in a
  `SPEC.md`; the root lint enforces declarations, citations, uniqueness, and
  resolution mechanically.
- Tests enforce externally meaningful invariants through their names,
  assertions, fixtures, and failure messages. Test comments reference the
  owning specification instead of becoming a second specification.
- Choose documentation form in this order: use a compact Mermaid diagram when
  the material is naturally a flow, state transition, ownership relationship,
  or composition; otherwise use a table when it is naturally an exact mapping
  or comparison; otherwise use an itemized list when it is naturally a set of
  distinct items; use prose only when none of those forms fits. Retain only the
  precise normative prose that the chosen form cannot express.
- When repository teaching conflicts with observed behavior or an owner ruling,
  stop consequential implementation. Record the contradiction in the owning
  issue, settle it, update the tagged specification, then update implementation
  and coverage. Remove superseded teaching instead of appending another account.

## Changes

Run package-focused tests while iterating, then the root gate before publishing
or claiming repository-wide success. For client/daemon behavior, verify the
assembled built product; a source-level test does not prove that an installed
executable works.

Changes spanning packages should preserve ownership: update the schema or
contract at its owning package, then update consumers. Do not introduce
compatibility aliases, dual paths, or transitional behavior unless compatibility
is itself an agreed requirement.
