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

`oxlint` runs beside `tsc` in the lint tier (`npm run lint:oxlint`, part of root
`test:lint`), over every workspace's sources, tests and `scripts/`, from the one
shared `.oxlintrc.json`. The gate fails on errors.

| Element | Contract |
| --- | --- |
| Categories | `correctness`, `suspicious` and `perf` are errors, with the typescript, unicorn, oxc, import, promise and node plugins. |
| Exceptions | A rule the codebase judges is named in the config with its reason: a warning while its sites are rewritten, or off when it is an opinion rather than an idiom here. |
| Inline disables | An `oxlint-disable-next-line` names its rule and states its reason on the same line. |
| Promises | Each promise in the Lint row above becomes a denied rule as its findings reach zero; a warning is a counted debt, never a permanent state. |

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
