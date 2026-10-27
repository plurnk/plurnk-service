# Repository tooling

## §native-source-toolchain Native ECMAScript source

| Surface | Contract |
| --- | --- |
| Runtime | Node 26 or newer; source execution uses native type stripping, and published execution uses built ESM. ESNext is a compiler target, not permission to require an API absent from the supported runtime. |
| Compiler | TypeScript 7, ESNext target and libraries, NodeNext module semantics. Workspaces inherit `tsconfig.base.json`; browser checks add DOM libraries without Node globals. |
| Source | Verbatim imports and erasable-only syntax keep direct and built execution aligned. Preserve useful type abstractions; do not require transformation-only TypeScript syntax. |
| Lint | No `var`, explicit `any`, deprecated APIs, or unprefixed Node built-ins in handwritten source. `const` for every binding assigned once, tests included; a binding a closure reads before its one assignment stays `let`. |

## §lint-gate Lint and the deterministic drill

`oxlint` runs beside `tsc` in the lint tier (`npm run source:check`, part of `root:lint`), over every workspace's sources, tests and `scripts/`, from `.oxlintrc.json`. Type-aware rules read every file through a `tsconfig.json` whose program contains it (`plurnk-core/test/tsconfig.json` for core tests; root `tsconfig.json` for root scripts and fixtures). An `oxlint-disable-next-line` names its rule and states its reason on the same line.

`scripts/drill.mjs` (`npm test`, run by the pre-push hook in a throwaway worktree) builds the platform once, runs `root:lint` and `root:unit`, then runs every workspace's `test:lint` and `test:unit`, then scopes `test:intg` to the changed workspaces (or full integration when a root or framework package changes; skipped on Markdown-only pushes outside `plurnk.md`). Parallelism is bounded by the host's available cores and memory at the measured per-process footprint, distributed across lanes via `PLURNK_TEST_CONCURRENCY`. Every `node --test` tier prints native coverage as report-only output before `--test` with no coverage threshold.

| Policy / Audit | Enforced Rule |
| --- | --- |
| Package graph (`scripts/dependency-policy.mjs`) | Frameworks never depend on their extensions ({§core-extension-composition}); packages never depend on a less stable layer; no cycles; devDependencies are not graph edges; install scripts must be reviewed in `allowScripts`; npm config lives only at the root. |
| Environment surface (`scripts/env-surface-policy.mjs`) | Every number and choice read in shipped source is declared on `.env.defaults` ({§operator-config-precedence}); no inline defaults, `DEFAULT_*` constants, or fallback readers; duration/size/limit constants require a mechanism-register entry; the allowance ratchet only shrinks. |
| Package lifecycle (`scripts/package-lifecycle-policy.mjs`) | Each workspace's `test` composes its `test:lint`, `test:unit`, and `test:intg` tiers in canonical order with no synonym or no-op tiers, no consumer `prepare`, and quoted recursive globs. |
| Commit provenance & conventions (`scripts/commit-provenance.mjs`, `scripts/conventional.mjs`) | Every pushed commit carries a valid signature and registered author/committer identities; commit subjects are one conventional line ≤ 100 chars citing `(#N)` with no body; branches are `main` or `<type>/<kebab-slug>`. |
| Runtime import direction (`npm run audit:direction`) | Over built `dist` output: erased type imports are not edges, side-effect imports are; owner boundaries hold on emitted imports; unresolved imports or missing build output fail. |

## §packed-projection Package build and tarball projection

Every publishable workspace whose package projection includes `dist` owns one `build:clean` (`rm -rf dist`), begins `build` with it, keeps emission-only work in `build:dist`, and runs the complete `build` from `prepack` (`scripts/package-build-policy.mjs`).

The published tarball is a projection of the source (`scripts/lib/package-projection.mjs`, `scripts/lib/package-artifacts.mjs`, `scripts/package-provenance.mjs`): the packed manifest strips the `plurnk-dev` export condition, every remaining export target (including subpath patterns) must exist in the archive, required runtime-loaded files and teaching assets must be present, and test helpers or fixture builders are refused. `npm run packages:types` (`scripts/package-types.mjs`) verifies packed public exports with ATTW under `esm-only`.

## §scripts-layout Directory layout and the field guide

Every code file at the top of a `scripts/` directory (and under `scripts/audit/`) is an entry point named by a `package.json` script or git hook, and nothing in `package.json` or `.githooks/` names a module under `scripts/lib/`. `scripts/anatomy/` holds manual refactoring and audit helpers; `scripts/fixtures/` holds test fixture servers and inputs.

`AGENTS.md` holds the operating rules and a map of the repository. Every `npm` command it spells must be a script of the package it names, every `name:name` script it mentions must exist in some `package.json`, and every repository path it names must exist (`scripts/layout.test.mjs`).

## §environment-layers Layered real-model environment and launchers

Real-model runs (`test:live`, `tier:live`, `tier:demo`, provider probes, `candidate`) layer configuration from highest to lowest precedence (`scripts/lib/environment.mjs`):

| Layer | Source | Purpose |
| --- | --- | --- |
| Shell | Login shell via `scripts/operator-environment.sh` | Provider credentials and per-run `PLURNK_MODEL=<selector>` |
| Gate profile | `plurnk-core/.env.test` | Deterministic gate posture (no authentication, no schedules, no personal policy) |
| Operator file | `$XDG_CONFIG_HOME/plurnk/.env` | Reusable model aliases and standing model selection |
| Package defaults | `plurnk-*/.env.defaults` | Every shipped knob and its default |
| Floor | `plurnk-core/test/floor.ts` | Installed package defaults, set-if-unset |

`scripts/candidate.mjs` boots a source-built daemon from a pinned runtime copy and an explicit `PLURNK_CLIENT_CHECKOUT`, parses `PLURNK_CANDIDATE_CLIENT_ENV` without allowing daemon-routing overrides, reaps the daemon on client signal termination, and snapshots the project root at the grade deadline ({§share}). `scripts/orientation.mjs` (`scripts/lib/orientation-verdict.mjs`) accepts an orientation run only when it is terminal, inspected repository files via model `READ` operations rather than archived issue URLs, published workspace documentation cleanly, and covered the platform topology and current forge state.

## §package-release-contract Independent package versions

Each package's public contract owns its SemVer. Compatible platform functionality warrants a minor release; dependency fixes or major updates create consumer patches unless the consumer's own contract changes. Changesets records explicit package-level release intent with no fixed or linked version groups, leaving unchanged compatible dependents untouched (`scripts/release-version.mjs`).

## §release-candidate-graph Selected publication graph

The release workflow selects named packages at their committed `major.minor.patch` versions, verifies external dependencies are at registry `latest` unless waived in `deps-waivers.json` without `ownerVeto` (`scripts/deps-preflight.mjs`), qualifies packed archives in a clean consumer install with production `npm audit` and an authenticated daemon probe ({§acp-http-authorization}), and uploads layers in dependency order after verifying registry visibility and immutable artifact integrity (`scripts/release-check.mjs`, `scripts/release-gates.mjs`, `scripts/release-publish.mjs`). Shared npm JSON readers (`scripts/lib/npm-json.mjs`) normalize `npm pack --json` and `npm view --json` output and reject empty or ambiguous responses.

## §release-finalization Publication records and mirror synchronization

Before creating release records, `scripts/release-finalize.mjs` verifies canonical PossumTech repository authority, signed commits on `main`, npm registry visibility, and GitHub release-write permission. GitHub is a mirror of the canonical forge: before any tag or release record is written, `github/main` is fast-forwarded to the canonical `origin/main` commit (`--no-verify`), and any non-fast-forward or tag conflict aborts finalization. Each package release receives a signed Git tag (`v<version>` for products, `<package-name>@<version>` for modules) pushed to both `origin` and `github`, and a GitHub Release with notes extracted from `CHANGELOG.md` at the verified commit. Retries repair only missing remote tags or release records.
