# Repository tooling

## §native-source-toolchain Native ECMAScript source

| Surface | Contract |
| --- | --- |
| Runtime | Node 26 or newer; source execution uses native type stripping, and published execution uses built ESM. ESNext is a compiler target, not permission to require an API absent from the supported runtime. |
| Compiler | TypeScript 7, ESNext target and libraries, NodeNext module semantics. Workspaces inherit the shared base; browser checks add DOM libraries without Node globals. |
| Source | Verbatim imports and erasable-only syntax keep direct and built execution aligned. Preserve useful type abstractions; do not require transformation-only TypeScript syntax. |
| Lint | No `var`, explicit `any`, deprecated APIs, or unprefixed Node built-ins in handwritten source. `const` for every binding assigned once, tests included; a binding a closure reads before its one assignment (`let owner; t.after(() => owner?.stop())`) stays `let`. Generated/vendor code remains outside source-style enforcement. |
| Resources | Use native resource management where the owned resource implements disposal and the lexical lifetime fits. Callbacks, process-local handles, and asynchronous lifetimes need not become `using` declarations. |

The ordinary gate checks source and built behavior. A stylistic sweep is not an
invitation to replace sound types, invent compatibility code, or change external
protocol support.

## §lint-gate Lint is a gate

`oxlint` runs beside `tsc` in the lint tier (`npm run source:check`, part of root
`test:lint`), over every workspace's sources, tests and `scripts/`, from the one
shared `.oxlintrc.json`. The gate fails on errors.

| Element | Contract |
| --- | --- |
| Categories | `correctness`, `suspicious` and `perf` are errors, with the typescript, unicorn, oxc, import, promise and node plugins. |
| Exceptions | A rule the codebase judges is named in the config with its reason: a warning while its sites are rewritten, or off when it is an opinion rather than an idiom here. |
| Inline disables | An `oxlint-disable-next-line` names its rule and states its reason on the same line. |
| Promises | Each promise in the Lint row above becomes a denied rule as its findings reach zero; a warning is a counted debt, never a permanent state. |

## Policies the root lint enforces

Each step of `npm run root:lint` is one script with one rule; the rule is stated here and the script
refuses the tree when it does not hold.

| Policy | Rule |
| --- | --- |
| §package-graph-policy Package graph | A framework never depends on an extension of its kind ({§core-extension-composition}); a package never depends on a less stable layer; no cycle; development dependencies are not graph edges; every package that ships an install script is reviewed by name. `scripts/dependency-policy.mjs`. |
| §env-surface-policy Environment surface | Every number and choice a shipped source reads is declared on a panel (`.env.defaults`), live or as an optional knob; a computed name is a family covered by one declared example; a read never carries its own value and a constant named DEFAULT is a default living in code; a live declaration nothing consumes means the panel lies; one package owns a key; prose, messages, tests and fixtures are not reads; reading the system environment is mechanism, never debt; a number whose name says duration, size or limit is a choice unless the mechanism register says why it is not; the allowance file is a ratchet: new debt is refused, and so is a paid debt left on the books ({§operator-config-env-defaults}). `scripts/env-surface-policy.mjs`. |
| §build-projection Build projection | Every workspace whose package projection includes `dist` owns one `build:clean`, begins `build` with it, keeps emission-only work in `build:dist` and builds from `prepack`; the scope is derived from the published projection, so a package that ships no `dist` owns no cleanup. `scripts/package-build-policy.mjs`. |
| §package-lifecycle Package lifecycle | A workspace's `test` is exactly its `test:lint`, `test:unit` and `test:intg` tiers in that order, omitting a tier it does not have, never a synonym tier and never a no-op; a workspace owns at least one tier; external, release and forensic commands keep their classified names; no workspace imposes a `prepare` on consumers; a recursive glob in any script is quoted so node expands it rather than `sh`. `scripts/package-lifecycle-policy.mjs`. |
| §packed-projection Packed projection | The tarball is a projection of the source: the published manifest carries no `plurnk-dev` export condition and everything else it declares is shipped (a subpath pattern ships when a packed file matches it; a condition aimed outside the tarball names the export and the file); each package's runtime-loaded files are required packed inputs and its test helpers and fixture builders are refused (#797). `scripts/lib/package-projection.mjs`, `scripts/lib/package-artifacts.mjs`, checked by `scripts/package-provenance.mjs`. |
| §diagnostic-inventory Diagnostic inventory | Every Problem code and Notice a package mints is read lexically from its TypeScript — constructors, parser errors and recovery clauses, with source coordinates, in deterministic file and source order; a private helper call, a regex and a string are not declarations. `scripts/diagnostic-inventory.mjs`, the reader behind {§problem-codes-declared}. |
| §commit-conventions Commit conventions | A commit is one conventional subject line of at most 100 characters with no body; generated merge and revert subjects pass; a template may carry blank and comment lines after the subject; a branch is `main` or `<type>/<kebab-slug>` over the same conventional types. `scripts/conventional.mjs`, run by the git hooks. |

## Audits on demand

| Audit | Rule |
| --- | --- |
| §runtime-import-direction Runtime import direction | Over the built output, never the TypeScript: erased imports and type-only re-exports are not edges, a side-effect import beside a type-only import is; owner boundaries hold on emitted imports; an unresolved import or missing build output is a refusal (#1053). `npm run audit:direction`. |
| §type-resolution-audit Type resolution | Packed public code resolves its exported types from a consumer's view under the `esm-only` profile, assets excluded; a selection names an exact workspace and refuses an absent or private one; every checker failure is reported and none becomes success. `npm run packages:types`. |

## Launchers

§candidate-launcher **The candidate launcher** boots a source-built daemon and the terminal client from
explicit checkouts: `PLURNK_CLIENT_CHECKOUT` is required, shared by the candidate and release lifecycles,
and the conformance sibling default applies only when no checkout is supplied; relative experiment
overrides are preserved; client overrides (`PLURNK_CANDIDATE_CLIENT_ENV`) parse one deterministic string
map and may not reroute the daemon; a client terminated by a signal reaps the daemon; the grade deadline
photographs the project root while the run plays on ({§candidate-pinned-runtime}).

§orientation-verdict **The orientation verdict** accepts a report only when it is terminal, inspected its
evidence (a READ of the repository, not an archived issue URL) and covers the service, the contracts, the
client, the topology, current work or the forge's unavailability and its own gaps; a timeout, missing
coverage, empty delivery or a failed documentation publication fails it regardless of the model's answer.

## §script-help Every entry point explains itself

A script that a package.json names answers `--help` (and `-h`) before it does anything else,
through the one seam `scripts/lib/usage.mjs`; the seam answers only for the process's main module,
so a script another script imports stays silent:

| Line | Content |
| --- | --- |
| first | `usage:` followed by how to run it, by its npm script name with its arguments |
| then | what it does, in one or two sentences, citing the tag it serves |
| `Reads:` | the environment and files it consults |
| `Writes:` | what it produces, or `nothing` |

`scripts/script-help.test.mjs` runs every named script with `--help` and fails on a missing part, a usage
line that does not name the script, a non-zero exit, or any other output; `plurnk-core/src/service.ts`
answers through its own usage.

## §scripts-layout One directory lists what a person runs

`ls scripts` is the map of a package's own tooling, at the root and in each workspace: every code file
at the top of a `scripts/` directory (and under the root's `audit/`) is an entry point that a package.json
script or a git hook names, and nothing names a module under its `lib/`. `scripts/layout.test.mjs` fails
on either violation.

| Directory | Holds |
| --- | --- |
| `scripts/` | the entry points; `SPEC.md`; the data files a policy step reads |
| `scripts/lib/` | the modules the entry points import; the root's also serve the workspaces' harnesses |
| `scripts/audit/` | the on-demand audits (`npm run audit:*`) and their configuration |
| `scripts/anatomy/` | the refactoring tools, run by hand; their README is their map |
| `scripts/fixtures/` | the data the witnesses read |

A witness sits beside the file it proves (`scripts/lib/npm-json.test.mjs` beside `npm-json.mjs`); a
witness of several files, or of the repository, sits at the top level.

## §agents-map The field guide is rules plus a map

`AGENTS.md` holds the rules for working in the repository and a map of where everything else is;
operating instructions live in the `--help` of the script that performs them ({§script-help}) and in
the tagged specifications, never in the guide. `scripts/agents-map.test.mjs` keeps the map true: every
`npm` command it spells is a script of the package it names, every `name:name` script it mentions
exists in some package.json, and every repository path it names exists.

## §environment-layers The environment, layered once

A real-model run (the live and demo tiers, the providers' probes, the candidate) is configured by
these layers, highest precedence first; `scripts/lib/environment.mjs` is their one statement, and
`scripts/lib/environment.test.mjs` proves the order.

| Layer | Where | Sets |
| --- | --- | --- |
| The shell | the login shell, reached through `scripts/operator-environment.sh` | provider credentials; `PLURNK_MODEL=<selector>` for one run |
| The gate profile | `plurnk-core/.env.test`, committed | the posture that is the same on every machine; names no model |
| The operator file | `$XDG_CONFIG_HOME/plurnk/.env`, never committed | the model aliases and the standing selection |
| The package defaults | each package's `.env.defaults`, committed | every choice, with its documentation |
| The floor | `plurnk-core/test/floor.ts` | every installed package's defaults, set-if-unset |

A launcher spawns node with `realModelNodeFlags` (the last `--env-file-if-exists` wins, so they run
lowest to highest); a script already running calls `applyRealModelEnvironment` (`loadEnvFile` is
set-if-unset, so it walks highest first); the candidate daemon's `--env-file` is `gateProfile`. The
Mock tiers layer only their package's own `.env.defaults` under `test/setup.ts` and are not this cascade.

## §package-release-contract Independent versions

| Surface | Contract |
| --- | --- |
| Package | Its public contract owns its SemVer. A release changes its shipped implementation, documentation, or delivery requirements; matching another package's version is not a change. |
| Platform | The service is the assembled product. Compatible functionality warrants its minor release; fixes do not force a minor. Classify dependency changes by their effect on this product, not by copying the dependency's bump. |
| Dependencies | Declare compatibility per named dependency. Compatible packages may retain their existing versions; changing a required dependency or minimum creates a new consumer artifact. |
| Planning | Changesets records explicit package-level release intent and computes necessary internal dependent updates. No fixed or linked version groups. Unchanged compatible dependents and unrelated packages remain unchanged. |
| Composition | Exact installed versions and source/artifact identities are qualification evidence, not a global framework version or an extra compatibility declaration. |
| Repository | Workspace membership is a source boundary, not a synchronized release requirement. The private root is not another product version. |

## §release-candidate-graph Selected publication graph

| Boundary | Contract |
| --- | --- |
| Selection | The stable-release workflow selects named packages at their committed `major.minor.patch` manifest versions. An inventory or a neighboring checkout does not authorize its publication or make it a prerequisite. |
| Resolution | Candidate dependency and peer ranges must admit the selected version of that dependency. Unselected dependencies resolve normally from the registry; an excluded product cannot block the release. |
| Preparation | Version and dependency edits precede qualification. Publication never edits source, stamps another repository, or substitutes a different candidate. |
| Qualification | Build and test the source repositories; run package-specific release checks only for the selected packages, inspect their projected archives, and exercise the installed composition before publication. No ignored peer conflicts, forced incompatible overrides, or reliance on an unpublished registry version. |
| Installed daemon | Verify the spawned package/version and its own ephemeral listener, the unauthenticated Bearer challenge, a `client_credentials` exchange using a fresh probe-only secret, and an authenticated request ({§agui-http-authorization}, {§agui-oauth-clients}). Keep authentication enabled; graceful shutdown and failure cleanup remain part of the probe. |
| npm CLI boundary | Shared readers normalize `pack --json` arrays or package-keyed objects and `view --json` single manifests or one-element arrays. Empty/malformed artifact lists and ambiguous manifest sets fail; normalization never substitutes for artifact, source, or exact package/version verification. |
| Dependencies | Newer available versions are not a release prerequisite. Audit the fresh installed production composition at the moderate floor; advisory-service unavailability is a reported gap, not a clean audit. |
| Publication | Upload independent packages sequentially as one dependency layer; verify that layer's registry visibility and immutable artifacts before uploading its consumers. Query the exact package/version, not its latest tag. A registry failure is not evidence that a package is unpublished. |
| Retry | Retain qualified artifacts and their source identities. Resume only missing publication steps; a conflicting immutable artifact fails rather than being overwritten or accepted as equivalent. |

## §release-finalization Publication records

| Stage | Contract |
| --- | --- |
| Qualification | Canonical signed sources, npm authority, and GitHub release-write permission are checked before publication. |
| Sources | The selected package's canonical Git repository owns its source identity; directory names and inventory entries are not release authority. |
| Notes | The package's `CHANGELOG.md` section `## <version>` at the verified source commit supplies its release notes. Qualification and publication require that section before uploading artifacts. |
| npm and consumers | Package publication and installed-product verification precede release records. |
| Git | Each release gets a signed tag on its exact verified source commit: `v<version>` for products and standalone packages, `<package-name>@<version>` for other monorepo packages. Push to the canonical forge and GitHub mirror; never move an existing tag. |
| §release-mirror Mirror | GitHub is a mirror of the canonical forge with no automation of its own, so publication carries a release there: before any record names a commit, the mirror's `main` is brought to the canonical `main` that holds it by fast-forward push alone (`--no-verify`, since the canonical push owned verification), and a mirror that cannot fast-forward stops publication with no record written. A release is published only when the registry, the records and the mirror's `main` all carry it. Every gated landing mirrors the same way: `git push --no-verify github origin/main:refs/heads/main`. |
| GitHub | A stable Release names that tag and records the tested composition. A service release gathers its simultaneously released modules; otherwise each changed module has its own record. Existing published records are preserved; conflicts or hosting failures fail the train. |
| Repair | `release:finalize` uses retained qualification and successful registry-consumer evidence; it creates missing records without publishing npm packages or selecting today's HEAD. A retry resumes the missing stage. |

## §problem-codes-declared Problem codes are named by their owner

Every Problem code a package mints — a kebab-case literal followed by an HTTP status, the code argument of `Problems.create`, `Results.failure` or `Results.problem`, or a `code:` field in a result shape — is named in inline code inside a tagged block of that package's `SPEC.md` (a table counts when the paragraph before it carries the declaration); `scripts/problem-codes.mjs` refuses the root lint otherwise, so a code can be found from its symptom (#888). Shared constructors use the diagnostic inventory's lexical reader: their owner may be an expression, while calls inside comments or string examples are inert.
