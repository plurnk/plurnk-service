# Contributing

Questions, bug reports, and patches are welcome through
[GitHub issues](https://github.com/plurnk/plurnk-service/issues) and
[pull requests](https://github.com/plurnk/plurnk-service/pulls). For client-specific
work, use the [client repository](https://github.com/plurnk/plurnk).
Report vulnerabilities through [SECURITY.md](./SECURITY.md), not a public issue.

## Setup

Use the Node 26 line and the pinned npm version.

```sh
npm ci
npm test
```

`npm ci` activates the repository Git hooks and builds the workspaces. The root lifecycle is:

| Command | Contract |
|---|---|
| `npm start` | Run the daemon from TypeScript source. |
| `npm run build` | Build every publishable workspace from a clean `dist`. |
| `npm test` | Deterministic lint, unit, and integration gate, then client conformance — needs an installed terminal client checkout (`npm ci` there). Defaults to `../plurnk`; `PLURNK_CLIENT_CHECKOUT` selects another location. |
| `npm run test:<tier>` | Run one canonical `lint`, `unit`, or `intg` tier. |
| `npm run test:live` | Long-running real-model wire assertions. |
| `npm run changelog` | Print the notes pending since the last release tag. `CHANGELOG.md` is generated from tags (`-- --write`) and gated by `--check`, never edited by hand. |
| `npm run test:demo` | Long-running real-model outcome assertions. |
| `npm run test:providersPing` | Paid one-call probe of each keyed provider; retains sanitized response evidence outside the checkout. |
| `npm run config:list` | Validate and list configuration ownership and source classes without values. |
| `npm run candidate -- …` | Run an explicit client checkout against the source-built daemon. |
| `npm run audit:direction` | Audit package import direction and runtime cycles. |
| `npm run audit:unused` | Find unused files, exports, and dependencies. |
| `npm run audit:clones` | Find duplicated code across packages. |

The three `audit:*` commands run on demand, outside the ordinary gates. Their
configuration lives in `scripts/audit/`.

The deterministic gate requires Node/npm, Git, POSIX `sh`, and `pgrep`/`pkill`;
`jq` and package-local `test:llama` coverage are capability-dependent.

| Boundary | Required evidence |
|---|---|
| Local or feature branch | The affected canonical tier; feature pushes are not hooked gates. |
| Main push | Hooked `npm test`; root changes run full integration. |
| Release candidate | Preserved applicable live/demo/bench evidence, then `release:check`. |
| Publication | `release:publish` uses the qualified archives, verifies the registry-installed composition, and records the release. |
| Model or benchmark campaign | Explicit `test:live`, `test:demo`, or canonical `plurnk-bench`; never the hot path. |

## Development workflow

Maintainers integrate accepted contributions in the development forge and publish
them to GitHub; contributors do not need a separate forge account. There is no
hosted CI. Local hooks check commit conventions and signatures, then run `npm test`
on main pushes.

## Changes

Change the owning package, cover externally meaningful behavior, and remove
superseded paths and prose. A schema change is the next migration version;
released migrations are never edited. Never commit secrets, private
state, transcripts, or generated artifacts. Commit subjects are Conventional and
at most 80 characters; reference the issue when useful.

## Diagnostics

| Need | Canonical path |
|---|---|
| Configuration/startup | `npm run config:list`, then [`plurnk-core/INSTALL.md`](./plurnk-core/INSTALL.md); startup failure is authoritative for route-dependent credentials. |
| Deterministic test failure | The reported `~/benchmarks/intg-<lane>-<run>/` directory (`PLURNK_BENCHMARKS` overrides the root). Successful suites remove their own artifacts; failed suites retain them. |
| Runtime state/telemetry | [`plurnk-core/README.md`](./plurnk-core/README.md) for database, digest, and OpenTelemetry surfaces. |
| Candidate/model forensics | `candidate` prints its retained artifact directory; `npm run share -- <plurnk.db> [folder]` writes any database's digest from a consistent copy ([`plurnk-core/SPEC.md`](./plurnk-core/SPEC.md) {§share}). |
| Published type resolution | Optional `npm run packages:types` (or `-- --only plurnk-contracts`): pinned ATTW 0.18.5 checks actual packed packages, invoking their normal prepack builds. |

The type-resolution audit uses ATTW's `esm-only` profile and leaves its findings
visible. `plurnk-meta`'s `./POLICY.md` and `./recap.md` exports are excluded because
they are file assets, not code modules. The checker is fetched into npm's cache
on demand; it adds no project dependency or step to ordinary or release gates.
Its nonzero exit means the selected audit failed, not an advisory green result.
ATTW skips packages with no declarations; it complements, rather than replaces,
the existing package-content and publint checks.

An in-process test timeout does not contain synchronous allocation or native
work. Run suspected resource-exhaustion cases under OS memory and swap limits;
retain their output outside `/tmp`. On Linux with a systemd user manager, for
example:

```sh
systemd-run --user --scope -p MemoryMax=1G -p MemorySwapMax=0 \
  node --test path/to/focused.test.mjs > focused-test.log 2>&1
```

Choose a limit for the focused workload, not the entire machine. For binary
equality, assert `actual.equals(expected)` rather than deep-diffing large
Buffers; the byte comparison remains exact and failure diagnostics stay bounded.

### Native coverage and profiling

Use Node's [coverage](https://nodejs.org/api/test.html#collecting-code-coverage)
and [profilers](https://nodejs.org/api/cli.html#--cpu-prof) on a focused
reproduction. Keep the owning package's test preloads and environment flags;
place diagnostic options before the test filenames.

| Question | Node options | Evidence |
|---|---|---|
| Which paths did this test exercise? | `--experimental-test-coverage --test-coverage-include=<source-glob>` | Text summary; `--test-reporter=lcov` produces LCOV. |
| Where is CPU time spent? | `--cpu-prof --diagnostic-dir=<directory>` | `.cpuprofile` per participating process/thread. |
| Where are sampled JavaScript allocations retained? | `--heap-prof --diagnostic-dir=<directory>` | `.heapprofile`; not total RSS, native memory, or proof of a leak. |

For example, from the repository root:

```sh
mkdir -p "$HOME/benchmarks"
diagnostics_dir=$(mktemp -d "$HOME/benchmarks/node-diagnostics-XXXXXX")
node --conditions=plurnk-dev --env-file=plurnk-meta/.env.defaults \
  --cpu-prof --heap-prof --diagnostic-dir="$diagnostics_dir" \
  --test --test-concurrency=1 --test-timeout=30000 plurnk-meta/src/Knob.test.ts
```

Run coverage and timing investigations separately: instrumentation affects the
workload. Keep Node version, command, source identity, and test outcome with the
artifacts. Compare like workloads; coverage describes only the selected tests,
and profile files must not be mistaken for a whole-process-tree memory total.
These are on-demand diagnostics, not additional gates or live-run defaults.

## Source-built candidate

```sh
PLURNK_CLIENT_CHECKOUT=/path/to/plurnk \
PLURNK_MODEL=<configured-alias> npm run candidate -- <client arguments>
```

The launcher builds the explicitly selected client and service, creates an
isolated database, and reports their provenance. It preserves a digest under
`../benchmarks` unless `PLURNK_BENCHMARKS` selects another path.
For repeated experiments, build both checkouts once and set
`PLURNK_CANDIDATE_SKIP_BUILD=1`. Each run pins its own copy of that build for
execution and digest export ({§candidate-pinned-runtime}).

## Metaproject readiness

`npm run readiness:metaproject -- --model <selector> [--requiem] [--preserve]` asks
a model, through the outside client, to inspect an assembled open-project forest
and deliver an evidence-bearing orientation report. It is expensive and runs only
after the package, integration, live/demo, candidate and bench layers are healthy;
it is not a release gate.

- **Preconditions**, each a failure when missing, never a skip:
  - `PLURNK_ACCEPTANCE_PROJECT_ROOT`, the assembled forest with its root `AGENTS.md`;
  - `PLURNK_CLIENT_CHECKOUT`, the built outside client;
  - a clean service checkout.
- **Verdict** (`scripts/orientation-verdict.mjs`): the report must be terminal and
  must have inspected the repository, including a READ. It must cover the service,
  the contracts, the client and AG-UI, the repository topology, current work (or the
  forge's unavailability) and its own gaps.
- **Evidence**: each preserved run claims `benchmarks/run<N>-orientation/` with the
  prompt, the client and service logs, `phases.json`, `verdict.json`, `plurnk.db`, and
  its share in `digest/` (with the requiem under `--requiem`). A failing run is always
  preserved.

## Release

Packages have independent versions ({§package-release-contract}). Add a changeset
for each public change; describe the service's outward effect explicitly when it
also needs a release. Compatible, unchanged packages do not need new versions.
Standalone repositories use their own version preparation and dependency ranges.

Dependency upgrades are separate maintenance. Inspect available updates with
`npm outdated --include-workspace-root --workspaces`; newer versions alone do
not block publication ({§release-candidate-graph}).

```sh
npm run changeset
npm run release:version
# Review the manifests, per-package changelogs and lockfile; land through the gate.
PLURNK_CLIENT_CHECKOUT=/path/to/plurnk npm run release:check -- \
  /path/to/new-release-artifacts plurnk-contracts plurnk-core /path/to/plurnk
npm run release:publish -- /path/to/new-release-artifacts
```

The package directories above are an example selection, not a fixed train. Name
every unpublished dependency candidate; all other dependencies resolve normally.
Only selected repositories are prerequisites. Each must be clean, signed and
accepted on canonical `main`, with npm and GitHub publication authority.

`release:check` builds and gates source, projects archives, and tests a fresh
installed composition. It retains those exact archives, source identities, and
resolved dependency evidence. `release:publish` changes no source: it publishes
dependencies before consumers, verifies registry-installed products, and records
the release. Registry errors stop publication; only an explicit missing version
permits a new upload. On interruption, retry **the same artifact directory**;
already-served artifacts must match byte-for-byte ({§release-candidate-graph}).

Products and standalone packages use signed `v<version>` tags; other monorepo
packages use `<package-name>@<version>`. Service releases gather their concurrent
modules into one GitHub record; independent module releases get their own records.
Preserve applicable live/demo and benchmark evidence in the issue. Regenerate the
root product changelog after new product tags: `npm run changelog -- --write`.

To repair missing tags or release records after successful registry verification,
without republishing packages:

```sh
npm run release:finalize -- /path/to/qualified-release-artifacts
```

Existing signed tags and published release records are verified and preserved
({§release-finalization}).

## Reviews and reports

State the problem, tradeoffs, verification, and compatibility effect. Reports need
provenance, a minimal reproduction, expected/actual behavior, and sanitized logs.
See [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md) and [SECURITY.md](./SECURITY.md).
