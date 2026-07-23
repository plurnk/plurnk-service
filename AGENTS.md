# PLURNK platform monorepo

PLURNK is an agent-development platform composed of a daemon, a model-facing
grammar, plugin families, and thin clients.

This repository is an npm workspace containing the daemon
(`plurnk-core`, published as `@plurnk/plurnk-service`), the grammar, the AG-UI
server module, and the plugins included in the default installation. The
command-line client and editor integrations are separate repositories.

## Architecture and ownership

- `plurnk-core` owns daemon lifecycle, persistence, workspaces, workers, loops,
  packet assembly, and orchestration.
- `plurnk-grammar` owns the model-facing language and shared protocol schemas.
- `plurnk-agui` owns the external client protocol and translates between AG-UI
  and daemon operations.
- `plurnk-providers*`, `plurnk-schemes*`, `plurnk-mimetypes*`, and
  `plurnk-execs*` own their respective plugin contracts and implementations.
- `plurnk-meta` contains shared package discovery and model-facing reference
  material. It is not a second orchestration layer.

Dependencies should point from consumers to the smallest package that owns the
required contract. Do not duplicate schemas, package discovery, configuration
rules, or protocol types in another package.

See `ARCHITECTURE.md` for process boundaries and data flow. Package-level
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

Use the root lockfile. Internal runtime and development dependencies use exact
versions. Plugin peer dependencies use the supported compatible range. Keep the
dependency graph valid under `npm ls --all`; do not force incompatible
transitive versions with root overrides.

## Contracts

- JSON Schema is authoritative for shared wire shapes.
- TypeScript types provide local ergonomics and should be generated from shared
  schemas where generation is already part of the package workflow.
- Each environment variable is documented by the package that reads it.
- Reject invalid state at the boundary that owns the contract. Recovery,
  retries, and compatibility behavior must be intentional and tested; they are
  not categorically forbidden.
- Prefer established ecosystem protocols and terminology. A divergence requires
  a concrete interoperability or product benefit, documented in
  `plurnk-meta/DIVERGENCES.md`.

## Documentation

Documentation is for maintainers and users, including agents. Write ordinary,
concise technical documentation:

- describe the current system, not the history of how it was debated;
- link to issues and commits for historical rationale;
- avoid duplicating source code, schemas, or another package's contract;
- remove stale plans and superseded instructions;
- use examples for behavior that is otherwise difficult to infer.

`AGENTS.md` files contain only durable repository or package guidance. They are
not project journals, issue trackers, or substitutes for architecture and API
documentation.

## Changes

Keep changes scoped and add tests at the lowest layer that proves the behavior.
For client/daemon behavior, also verify the assembled product path. A passing
source-level test does not prove that a stale built or installed executable
works.

Use conventional commit subjects. GitHub issues track defects and planned work;
they do not become permanent doctrine merely because a decision was once
recorded there.

Every agent authors commits as itself. Agent work keeps authorship and
acceptance distinct: use `Claude <noreply@anthropic.com>`,
`Codex <noreply@openai.com>`, or `Plurnk <plurnk@pm.me>` as appropriate; the
human operator remains `wikitopian <wikitopian@pm.me>` as committer and signer.
The pre-push hook rejects unknown identities and invalid signatures.
