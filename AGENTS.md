# PLURNK platform monorepo

The field guide: the rules for working in this repository and a map of where everything else is.
It is self-contained — everything an agent or a contributor needs to act is here or in the
documents it names — and `scripts/layout.test.mjs` keeps every command and path named here
true ({§scripts-layout}). How to run a thing is the thing's own `--help`, never a paragraph here.

This repository is an npm workspace containing the daemon (`plurnk-core`, published as
`@plurnk/plurnk-service`), the contracts and grammar authority, the ACP server module, and the
extensions included in the default installation. The terminal client is a separate repository,
`../plurnk` beside this one.

## Map

| Need | Where |
|---|---|
| What a command does | `ls scripts` lists what a person runs ({§scripts-layout}); every script answers `--help`; `npm run` lists each package's names. |
| Install, build, gate | `npm install`, `npm run build`, `npm test` (the drill, `scripts/drill.mjs`; the pre-push hook runs it on a push to `main`; {§lint-gate}). `CONTRIBUTING.md` § Setup has the lifecycle table. |
| A choice: a limit, a default, a posture | Each package's `.env.defaults`; `ARCHITECTURE.md` § Configuration authority is the law. The real-model layers, highest first: the shell, `plurnk-core/.env.test`, `$XDG_CONFIG_HOME/plurnk/.env`, the defaults, the floor ({§environment-layers}; `scripts/lib/environment.mjs` is the code). |
| A model | `PLURNK_MODEL_<alias>=<provider>/<model>` declared once in `$XDG_CONFIG_HOME/plurnk/.env`; `PLURNK_MODEL=<alias>` selects one per run, or standing in that file (`plurnk-aliases/SPEC.md`; provider ids in `plurnk-models`). Credentials live in the login shell, which `scripts/operator-environment.sh` carries into every real-model run. |
| A real-model run | From `plurnk-core`: `npm run test:live` (the thin live smoke; `--help` for its one-specimen form); `npm run candidate` at the root for the whole platform ({§share}); the full `live` and `demo` specimen corpora live in `../plurnk-bench/tiers/README.md`. |
| A run's evidence | `$PLURNK_BENCHMARKS/tier-<live\|demo>-<stamp>/census.md` and each session's `digest/` ({§test-artifact-retention}; the digest's files in `plurnk-digest/README.md`); `npm run digest:missing -w @plurnk/plurnk-service` re-digests interrupted specimens; `npm run share -- <plurnk.db> [folder]` writes any database's digest from a consistent copy it takes itself ({§share}). The database is evidence; the digest is the diagnostic interface. |
| The deterministic tiers | `test:lint`, `test:unit`, `test:intg` per package, booted by `plurnk-core/test/setup.ts` (a fake `mocktest` provider on fixture-scaled reserves, never a real model). |
| A release | `npm run changeset` with the change; `npm run release:version`, `release:check`, `release:publish`, `release:finalize` ({§package-release-contract}, {§release-finalization}); `CONTRIBUTING.md` § Release has the procedure, the major-only maintenance classes, and the per-major sweep. |
| The bench | The `plurnk-bench` checkout beside this one; read `../plurnk-bench/deepswe/README.md` before launching anything, and never reconstruct its invocation from memory. |
| Process boundaries, data flow, ownership | `ARCHITECTURE.md`; a package's public contract is its `SPEC.md`; implementation notes sit near the code they describe. |

## Rules for operating

- **Credentials** live in the login shell, never in any `.env` and never in the repository. Check
  readiness by name only; never print, echo or log a credential's value.
- **A daemon you did not start is a live session**: never stop it to free a port, and read its
  database only through `npm run share`. A daemon reads the card at every loop start and wake
  ({§packet-inject}), so a card edit needs no restart.
- **Select processes by pid**, never by pattern or location: `fuser -k <dir>` signals every process
  using that directory, the daemon included, and `pgrep -f`/`pkill -f` match the calling shell's own
  command line. When a pattern is unavoidable, bracket its first character (`[d]rill\.mjs`).
- **The gate is the push.** Run `npm run -s root:lint` before pushing. Commit subjects are one line of
  at most 100 characters citing `(#N)`, no body. The drill runs the pushed commit in a throwaway
  worktree with this checkout's `node_modules` copied whole, so run `npm install` after a change to
  the workspaces or the lockfile; the working tree may stay dirty and be edited while it runs. GitHub
  is a mirror of the Forge with no automation of its own: after the gate lands a commit, mirror it with
  `git push --no-verify github origin/main:refs/heads/main` ({§release-finalization}).
- **The client is part of the gate.** The drill's last phase boots the built service and checks the
  terminal client checkout (`../plurnk`, or `PLURNK_CLIENT_CHECKOUT`) against it
  ({§acp-first-party-client-conformance}): land a client change before the service push that depends
  on it; never leave that checkout half-edited while a gate runs; a type a service change moves or
  removes must leave the client compiling both against this checkout's packed packages and against its
  published dependencies. Its scripted model (`scripts/fixtures/client-journey-model.mjs`) asserts
  text from the teaching pages, so a teaching edit updates it in the same landing.
- **A dogfood session** — an operator driving a daemon through ordinary, unscripted messages — is read
  like a demo: share its database, then report friction first (refused or failed operations by family),
  then the message census (was every message answered, in what form, premature endings, packet echoes,
  anything that ran unasked), then pass rates. An advisory, a strike, an empty turn or a surprise
  mutation is a failure even when the final text is right.

## Package ownership

- `plurnk-core` owns daemon lifecycle, persistence, workspaces, sessions, loops,
  packet assembly, and orchestration.
- `plurnk-contracts` owns the model-facing language contract, the AST and
  shared types and schemas, runtime-neutral Problems, operation results, Notices,
  and text coordinates.
- `plurnk-parser` owns the ANTLR grammars and the parser that implements that
  language. Its importers are the service's execution path, `plurnk-acp`
  (`parseStatements`, for client-authored blocks) and `plurnk-execs`
  (`parseStatements` and `frame`, for runtime invocation and teaching examples);
  no other package parses the language.
- `plurnk-auth` owns the OAuth 2.1 authorization server module (`/.well-known/*`,
  `/oauth/*`) for the daemon's credential authority.
- `plurnk-acp` owns the external ACP v2 client protocol (`/acp`) and translates between
  ACP v2 and daemon operations.
- `plurnk-modules` owns the daemon module contract: the lifecycle a module
  implements and the base setup seam. Each framework owns the slice for what
  modules contribute to its kind.
- `plurnk-hooks` owns exact-command delivery of selected core lifecycle events.
- `plurnk-otel` owns the OpenTelemetry SDK: the trace and metric providers `OTEL_*` selects,
  registered as a module; the daemon instruments itself on the API alone.
- `plurnk-digest` owns forensic reports, consistent snapshots and interviews;
  core supplies canonical evidence through its public reader.
- `plurnk-providers*`, `plurnk-schemes*`, `plurnk-mimetypes*`, and
  `plurnk-execs*` own their respective extension contracts and implementations.
- `plurnk-meta` contains shared package discovery and model-facing reference
  material. It is not a second orchestration layer.
- `plurnk-spec-check` owns the shared development-only specification validator;
  it is not a daemon dependency.

Dependencies should point from consumers to the smallest package that owns the
required contract. Do not duplicate schemas, package discovery, configuration
rules, or protocol types in another package.

## Rules for the code

- **Read `ARCHITECTURE.md` § Configuration authority before adding a constant, a flag, a parameter
  default or a settings field.** The cascading environment is the only home for a choice; code holds
  mechanism only. Declare a reusable model alias once in the operator file and select it per run;
  never redeclare one inline. With no selector anywhere the daemon boots modelless and says so; the
  repository ships neither a model nor a credential.
- **The development runtime executes TypeScript source** with Node's type stripping and the
  `plurnk-dev` export condition; published executables use `dist`. Build before testing a binary or
  installed-package path: a source-level test does not prove that an installed executable works.
- **One lockfile.** Use the root lockfile and keep the dependency graph valid under `npm ls --all`.
  Internal workspace dependencies and extension peer dependencies use their declared compatible
  semver ranges; do not force incompatible transitive versions with root overrides.
- **One build projection.** Every publishable workspace whose package projection includes `dist` owns
  one `build:clean` step, begins its complete public `build` with that step, keeps emission-only work
  in `build:dist`, and runs the complete build from `prepack`; the root package-build policy and the
  release gates enforce this, so introduce no package-local cleanup variant. Build inputs are runtime
  package inputs: keep test-only and private harness helpers under their test or bench owner rather
  than compiling them into `dist`. When runtime code loads a module by exact path instead of through
  an export, assert that path in the root packed-artifact projection. The manifest a tarball carries
  is a projection too: `scripts/lib/package-projection.mjs` strips the monorepo's `plurnk-dev` export
  condition from every tarball the platform packs and refuses any remaining export whose target the
  tarball does not ship (#797).

## Monorepo contracts

- JSON Schema is authoritative for shared wire shapes.
- TypeScript types provide local ergonomics and should be generated from shared
  schemas where generation is already part of the package workflow.
- **Migrations.** Released SQLite versions are frozen ({§db-migrations}). A shape
  change is one new `migrations/` file at the next `MIGRATE` version that carries
  existing databases forward in place, with upgrade coverage. Never edit a released
  migration or tell an operator to delete a database.
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
  | Declaration | `§lowercase-kebab` | Exactly one at the first semantic position of a `SPEC.md` Markdown heading (`## §tag`, `### §tag`, or `#### §tag`). Paragraph, list-item, and table-row declarations are forbidden. |
  | Citation | `{§lowercase-kebab}` | Required everywhere outside the declaring heading, including other specifications, code, coverage, and diagnostics. Every declared tag requires both an implementation/panel witness and a test witness; every deterministic `test()` title cites at least one `{§tag}`, and multiple tests in a suite share their parent heading tag. |
  | Presentation | `§3`, `§3.bis` | Numeric document navigation is not a named contract tag. |

  Fenced, inline, and indented code examples are inert. Keep declarations
  globally unambiguous and do not silently reuse one for different semantics.
  A declaration must share its heading with a title and the section contract it names; a
  tag-only heading is invalid.
- Forge issues record observations, investigation, competing interpretations,
  rulings, rejected alternatives, and completion evidence. Issue numbers are
  provenance; specification tags are current authority.
- Issue provenance uses a mechanically distinct repository and host context:

  | Provenance                  | Form                                                                     | Rule                                                                 |
  |-----------------------------|--------------------------------------------------------------------------|----------------------------------------------------------------------|
  | Current issue in this Forge | `#N`                                                                     | Bare numbers resolve only in the canonical `plurnk-service` Forge.   |
  | Current external work       | Full canonical Forge issue URL                                          | Never abbreviate another repository to `repo#N`.                     |
  | Archived GitHub history     | Full `https://github.com/plurnk/<repo>/issues/N` or `/pull/N` URL        | Retain only when the historical evidence adds value beyond the tag. |

  A repository shorthand such as `plurnk-mimetypes#N` is ambiguous and
  forbidden. Once a ruling is stable, prefer its owning `{§tag}` and leave
  chronology in the issue or Git history.
- README material teaches concise usage derived from the specification. Do not
  turn specifications or READMEs into chronological design journals.
- Code and coverage may cite the owning specification tag and issue numbers, but must not
  duplicate the specification's architectural explanation or retain historical
  essays. Keep only genuinely local implementation constraints near code.
- Every named specification-tag citation must resolve to one declaration in a
  `SPEC.md`; the root lint enforces declarations, citations, uniqueness, and
  resolution mechanically.
- Tests enforce externally meaningful invariants through their names,
  assertions, fixtures, and failure messages. Integration assertions that don't
  enforce a tagged invariant should either create a tagged invariant or be removed.
  Test comments reference the owning specification instead of becoming a second
  specification.
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

**A rename is total.** When a concept's name changes, it changes everywhere that names the concept, in
one landing: types, schema, methods, Problems, knobs, wire actions, spec tags, tests, fixtures and docs.
A surface-only rename, a new flag over old internals, is a defect, not a first step.

**Retired forms are erased.** A retired name, syntax, knob, dependency, protocol or behaviour leaves no
trace in the living tree: no code, spec, doc, test, migration, comment or diagnostic refers to it, and
nothing recognizes it to refuse, shim or translate it. Never vendor or inline a retired dependency or
protocol under local names, run dual protocols on one endpoint, or relabel an old wire contract as the
new one; when an adopted standard has an official SDK, build on that SDK rather than hand-rolling its
wire or transport layer. Any record of a retired form invites its resurrection. History lives in git,
issues and published changelogs.

**A benchmark is evidence on one axis, never the scope.** A page or contract serves every model and
every task.

**The model curates its context.** The verbs are the curation ({§tokenomics}): the daemon adds no
compaction, folding, summary or other mechanism the model did not emit, however a benchmark goes.

**Teach stricter than tolerated.** The card and reference pages teach one canonical form; the parser may
accept near-misses of it. A refusal shows the working form of the construct it refused
({§parse-recovery}) and nothing more: general syntax and workflow teaching stays on the card
({§diagnostic-observation}). Card examples use generic placeholders and teach grammar before using it.

**A contract works without a whiteboard.** Prefer the simplest rule that can be stated and reasoned
about directly over layered permissions, fallback chains, or daemon state that covers for an absent party.

**Every contract mechanism has a matrix witness.** Coverage enumerates the mechanism's dimensions, as the
fence-pairing and message-completion matrices do, rather than sampling one path.

**A diagnostic says what happened, never why** ({§diagnostic-observation}). A message names what
was read, what was done with it and where, and may show the construct's working form; it never
guesses the author's intent or the cause. An existing message is no license: check every sentence
against what the producer itself decided.
