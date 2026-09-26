# PLURNK platform monorepo

The field guide: how to work in this repository. It is self-contained — everything
an agent or a contributor needs to act is here or in the documents it names.

This repository is an npm workspace containing the daemon
(`plurnk-core`, published as `@plurnk/plurnk-service`), the contracts and
grammar authority, the AG-UI server module, and the plugins included in the default installation. The
terminal and optional web clients are separate repositories.

## Operations quick reference

Where things are, for an agent that has to act before it has read everything:

- **Models are declared in `$XDG_CONFIG_HOME/plurnk/.env`** (`~/.config/plurnk/.env`),
  one alias per line: `PLURNK_MODEL_<alias>=<provider>/<model>`. Alias names may carry
  lowercase (`PLURNK_MODEL_ibm`). `PLURNK_MODEL=<alias>` selects one per run. The
  operator's daily default is whatever `PLURNK_MODEL` that file sets.
- **Provider credentials live in the login shell environment**, never in any `.env`
  and never in the repository. `scripts/operator-environment.sh` re-executes its
  command under `~/.bashrc` when one exists (and runs it unchanged otherwise), so
  every live, demo, bench and candidate run inherits `<PROVIDER>_API_KEY`. Check
  readiness by name only; never print, echo or log a credential's value.
- **Run a model** from `plurnk-core`: `PLURNK_MODEL=<alias> npm run test:live`
  (specimens in `test/live/`), `npm run test:demo` (stories), or
  `npm run test:live:specimen -- "<exact name>"`. The whole-platform candidate is
  `npm run candidate` at the root (see README).
- **Every live or demo worker leaves evidence** under `~/benchmarks/<label>-XXXXXX/`:
  `plurnk.db`, `workspace`, and `digest/` with `digest.md` (loops, turns, ops,
  errors, cost), `<worker>-<loop>-<turn>.assistant.md` (the model's raw emissions),
  `.user.md` and `.system.md` (what it saw), named by log coordinate. Read the digest;
  the database is evidence, never the diagnostic interface. For any other database,
  `npm run share -- <plurnk.db> [folder]` writes the same folder
  from a consistent copy it takes itself ({§share}); a live database is safe to name.
- **A daemon may already be attached to this checkout**, run from its source and
  listening on `PLURNK_PORT` (1066 by default) — commonly as a user service
  (`systemctl --user status plurnk`, `journalctl --user -u plurnk -f`). Treat any
  daemon you did not start as a live session someone is using: never stop it to free
  a port, never select processes by the directory they happen to sit in, and never
  read its database except through a copy.
- **The bench lane** is the `plurnk-bench` checkout beside this one; read
  `deepswe/README.md` there before launching anything, and never reconstruct its
  invocation from memory.
- **Landing**: topic branch, `npm run -s root:lint`, then `git push origin <branch>:main`.
  The pre-push drill is the gate (lint, unit, intg, client conformance against
  `../plurnk`). It runs the pushed commit in a throwaway
  worktree beside this checkout (`plurnk-service.wt-gate-<pid>`, removed when the
  drill ends), so the working tree may stay dirty and be edited while it runs; intg
  scopes to the changed leaf workspaces and runs in full for a root-level, `plurnk-core`,
  or `plurnk-contracts` change. On green, fast-forward local `main`, delete
  the branch with `git branch -d`, mirror with
  `git push --no-verify github origin/main:refs/heads/main`. Commit subjects are one
  lowercase-led line citing `(#N)`, no body.
- **Release train** (`scripts/release-*.mjs`): `npm run release:version -- <service-version>`
  stamps the platform; land the stamp through the normal gate. Then, from a clean `main` with
  `PLURNK_CLIENT_CHECKOUT=<client checkout>` and `PLURNK_EXTERNAL_REPOS_ROOT=<directory holding
  the sibling checkouts>` exported,
  run `npm run release:publish -- <client-version>` under `setsid` with its output in a log:
  it outruns a ten-minute shell cap, so watch the log, never the registry. It re-runs the
  drill, then `release-gates` (one bounded `npm audit` that warns and continues when the
  advisory endpoint is rate-limited, #649, and fails only on a real ≥moderate finding), then
  publishes the service and the client, signs and mirrors their `v<version>` tags,
  and creates the GitHub Release entries. GitHub CLI write access is preflighted.
  `npm run release:finalize -- <service-version> <client-version>` repairs missing
  records from existing signed tags without npm publication. Afterwards, regenerate
  and commit the changelog, then relock the bench checkout with
  `npm update @plurnk/plurnk-service --no-audit --no-fund`.
  Every install passes `--no-audit` (the project `.npmrc` sets `audit=false`): npm's
  advisory endpoint drops over-limit requests instead of answering 429, and retries and
  probes only feed the limit.

## Package ownership

- `plurnk-core` owns daemon lifecycle, persistence, workspaces, workers, loops,
  packet assembly, and orchestration.
- `plurnk-contracts` owns the model-facing language contract, the AST and
  shared types and schemas, runtime-neutral Problems, operation results, Notices,
  and text coordinates.
- `plurnk-parser` owns the ANTLR grammars and the parser that implements that
  language; only the service's execution path imports it.
- `plurnk-agui` owns the external client protocol and translates between AG-UI
  and daemon operations.
- `plurnk-hooks` owns exact-command delivery of selected core lifecycle events.
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

Every publishable workspace whose package projection includes `dist` owns one
`build:clean` step, begins its complete public `build` with that step, keeps
emission-only work in `build:dist`, and runs the complete build from `prepack`.
The root package-build policy and release gates enforce this projection; do not
introduce package-local cleanup variants.

Build inputs are runtime package inputs. Keep test-only and private harness
helpers under their test or bench owner rather than compiling them into `dist`.
When runtime code loads a module by exact path instead of through an export,
assert that path in the root packed-artifact projection. The manifest a tarball
carries is a projection too: `scripts/package-projection.mjs` strips the
monorepo's `plurnk-dev` export condition from every tarball the platform packs
(the provenance gate, the conformance harness, the publish machine) and refuses
any remaining export whose target the tarball does not ship (#797).

## Configuration cascade and test tiers

**Read [`ARCHITECTURE.md` § Configuration authority](./ARCHITECTURE.md#configuration-authority)
before adding a constant, a flag, a parameter default or a settings field.** The
cascading environment is the only home for a choice; code holds mechanism only.
What follows here is only the order the layers apply in.

Environment layers highest-precedence-first. `loadEnvFile` is set-if-unset, so a
value already set earlier (or in the shell) is never overwritten; among the
repeatable `--env-file-if-exists` flags the LAST flag wins. The live/demo tier
(`plurnk-core` `test:demo`) layers, highest first:

1. the operator's shell env — `scripts/operator-environment.sh` sources `~/.bashrc`
   before running, so the `<PROVIDER>_API_KEY` credentials (e.g. `DEEPSEEK_API_KEY`)
   are present and `PLURNK_MODEL=<selector>` here selects the model for one run,
2. `plurnk-core/.env.test` — the committed real-model gate profile: the posture that is the
   same on every machine (`PLURNK_SERVICE_FILES_ITEMS=-1`, `PLURNK_SERVICE_GIT_AUTO=1`,
   ambient operator surfaces cleared). It names no model,
3. `./.env`, then `$XDG_CONFIG_HOME/plurnk/.env` — operator files. The user file declares the
   model aliases (`PLURNK_MODEL_<alias>=<provider>/<model>`) and may set `PLURNK_MODEL`
   as this machine's standing selection; both are operator-owned and never committed,
4. per-package `.env.defaults` — committed safe defaults plus the authoritative env docs,
5. `test/floor.ts` — the assembled `.env.defaults` of every installed package,
   applied set-if-unset so it only fills genuinely-unset knobs.

Model selection: `PLURNK_MODEL=<selector>` accepts either a declared alias or an
exact `<provider>/<model>` route; `PLURNK_MODEL_<alias>=<provider>/<model>`
declares an optional reusable tuning scope (provider ids in
`plurnk-models/src/providers.json`). Resolution is `resolveActiveRoute()`
(plurnk-aliases) then `loadActiveProvider()` (plurnk-providers). Declare reusable
aliases once in `$XDG_CONFIG_HOME/plurnk/.env` and select them per run; never
redeclare one inline. With no selector anywhere the daemon boots modelless and says
so; the repository ships neither a model nor a credential.

The root drill (`npm test`) ends with a client conformance phase: it
boots the built service and compares the terminal client's
`conformance/agui-client.json` (`../plurnk`) against live
`discover`, so an action rename, scope, or module-surface change fails this
repository's push instead of silently breaking the client. The installed CLI
and TUI journeys require that checkout and its dependencies; `PLURNK_CLIENT_CHECKOUT`
selects another installed client location instead of the `../plurnk` default.

Test tiers: `test:lint` / `test:unit` / `test:intg` run per package against the
Mock-tier bootstrap (`node --import=./test/setup.ts` — a fake `mocktest` alias with
fixture-scaled reserves). The **demo** tier drives a REAL model through the prod
loop via `test/_live-harness.ts` (`liveWorkspace` + `liveLoop`) and uses the floor
bootstrap (`--import=./test/floor.ts`) instead; it boots a fresh throwaway workspace,
never the host repo, and is not part of `npm test`. Both tiers route through
driver scripts (`scripts/live.mjs`, `scripts/demo.mjs`) that layer the full
cascade (operator-environment.sh → floor.ts → `.env.defaults`, the XDG user `.env`,
`./.env`, `.env.test`) and place `--test-name-pattern` *before* the file list
(node ignores it after the files). Run from `plurnk-core`, selecting a model:

```sh
PLURNK_MODEL=<selector> npm run test:demo               # every demo story
PLURNK_MODEL=<selector> npm run test:demo:specimen -- <name-substring>   # one story
PLURNK_MODEL=<selector> npm run test:live                # every live specimen
PLURNK_MODEL=<selector> npm run test:live:specimen -- <exact name>       # one specimen
```

## Dogfood teamwork sessions

An operator drives a daemon in an ordinary, unscripted conversation — web research,
questions about plurnk's own syntax, changing their mind mid-task — and the session is then read
like a demo. Its lack of structure is the point: benchmarks grade the workspace afterwards, a
conversation grades the reply. Share the daemon's database; the share takes its own consistent
copy, so the daemon keeps running.

```sh
npm run -s share -- ~/.local/share/plurnk/plurnk.db ~/benchmarks/dogfood-teamwork-<stamp>
```

Report friction first (the standing rule): refused or failed operations by
family, then the **conversation census** — was every message answered, in what form (prose answer,
tolerated SEND, never), premature endings, packet echoes, and anything that ran which the operator
did not ask for. Pass rates and outcomes come after. An advisory, a strike, an empty turn or a
surprise mutation is a failure in this tier even when the final text is right.

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
- Issue provenance uses a mechanically distinct repository and host context:

  | Provenance                  | Form                                                                     | Rule                                                                 |
  |-----------------------------|--------------------------------------------------------------------------|----------------------------------------------------------------------|
  | Current issue in this Forge | `#N`                                                                     | Bare numbers resolve only in the canonical `plurnk-service` Forge.   |
  | Current external work       | Full canonical Forge issue URL                                          | Never abbreviate another repository to `repo#N`.                     |
  | Archived GitHub history     | Full `https://github.com/plurnk/<repo>/issues/N` or `/pull/N` URL        | Retain only when the historical evidence adds value beyond the tag. |

  Legacy shorthands such as `service#N`, `grammar#N`, or
  `plurnk-mimetypes#N` are ambiguous and forbidden. Once a ruling is stable,
  prefer its owning `{§tag}` and leave chronology in the issue or Git history.
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
- When repository teaching conflicts with observed behavior or the owning contract,
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
