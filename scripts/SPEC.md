# Repository tooling

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
| Qualification | Build and test the sources; inspect projected archives and exercise the installed composition before publication. No ignored peer conflicts, forced incompatible overrides, or reliance on an unpublished registry version. |
| Publication | Publish dependencies before consumers. Query the exact package/version, not its latest tag. A registry failure is not evidence that a package is unpublished. |
| Retry | Retain qualified artifacts and their source identities. Resume only missing publication steps; a conflicting immutable artifact fails rather than being overwritten or accepted as equivalent. |

## §release-finalization Publication records

| Stage | Contract |
| --- | --- |
| Qualification | Canonical signed sources, npm authority, and GitHub release-write permission are checked before publication. |
| Sources | The selected package's canonical Git repository owns its source identity; directory names and inventory entries are not release authority. |
| npm and consumers | Package publication and installed-product verification precede release records. |
| Git | Each release gets a signed tag on its exact verified source commit: `v<version>` for products and standalone packages, `<package-name>@<version>` for other monorepo packages. Push to the canonical forge and GitHub mirror; never move an existing tag. |
| GitHub | A stable Release names that tag and records the tested composition. A service release gathers its simultaneously released modules; otherwise each changed module has its own record. Existing published records are preserved; conflicts or hosting failures fail the train. |
| Repair | `release:finalize` uses retained qualification and successful registry-consumer evidence; it creates missing records without publishing npm packages or selecting today's HEAD. A retry resumes the missing stage. |

## §problem-codes-declared Problem codes are named by their owner

Every Problem code a package mints — a kebab-case literal followed by an HTTP status, the code argument of `Problems.create`, or a `code:` field in a result shape — is named in inline code inside a tagged block of that package's `SPEC.md` (a table counts when the paragraph before it carries the declaration); `scripts/problem-codes.mjs` refuses the root lint otherwise, so a code can be found from its symptom (#888).
