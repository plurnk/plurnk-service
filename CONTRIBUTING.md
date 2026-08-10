# Contributing

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
| `npm test` | Deterministic lint, unit, and integration gate. |
| `npm run test:<tier>` | Run one canonical `lint`, `unit`, or `intg` tier. |
| `npm run test:live` | Long-running real-model wire assertions. |
| `npm run test:demo` | Long-running real-model outcome assertions. |
| `npm run test:providersPing` | Paid one-call probe of each keyed provider; retains sanitized response evidence outside the checkout. |
| `npm run config:list` | Validate and list configuration ownership and source classes without values. |
| `npm run candidate -- …` | Run an explicit client checkout against the source-built daemon. |

The deterministic gate requires Node/npm, Git, POSIX `sh`, and `pgrep`/`pkill`;
`jq` and package-local `test:llama` coverage are capability-dependent.

| Boundary | Required evidence |
|---|---|
| Local or feature branch | The affected canonical tier; feature pushes are not hooked gates. |
| Main push | Hooked `npm test`; root changes run full integration. |
| Release candidate | Preserved applicable live/demo/bench evidence, then `release:check`. |
| Publication | `release:publish`, which repeats qualification before mutation. |
| Model or benchmark campaign | Explicit `test:live`, `test:demo`, or canonical `plurnk-bench`; never the hot path. |

## Forge workflow

PossumTech Gitea is the canonical maintainer forge; GitHub is the public downstream.
There is no hosted CI. Hooks enforce Conventional names and signed provenance,
then run `npm test` on main pushes.

## Changes

Change the owning package, cover externally meaningful behavior, and remove
superseded paths and prose. During the pre-migration phase, edit the version-1
schema baseline and recreate disposable databases. Never commit secrets, private
state, transcripts, or generated artifacts. Commit subjects are Conventional and
at most 80 characters; reference the issue when useful.

## Diagnostics

| Need | Canonical path |
|---|---|
| Configuration/startup | `npm run config:list`, then [`plurnk-core/INSTALL.md`](./plurnk-core/INSTALL.md); startup failure is authoritative for route-dependent credentials. |
| Deterministic test failure | The reported workspace `test/intg/.tmp/`; each normal run replaces only its own prior evidence. |
| Runtime state/telemetry | [`plurnk-core/README.md`](./plurnk-core/README.md) for database, digest, and OpenTelemetry surfaces. |
| Candidate/model forensics | `candidate` prints its retained artifact directory; [`plurnk-meta/DOGFOOD.md`](./plurnk-meta/DOGFOOD.md) defines digest/reasoning/requiem evidence. |

## Release

```sh
export PLURNK_CLIENT_CHECKOUT=/path/to/plurnk
export PLURNK_EXTERNAL_REPOS_ROOT=/path/to/repository-forest
npm run release:version -- <platform-version>
# Review and commit the stamp.
npm run release:check -- <client-version>
npm run release:publish -- <client-version>
```

`release:check` is the read-only qualification path; `release:publish` repeats it
before mutation and resumes torn runs by skipping served immutable packages.
Preserve applicable live, demo, and canonical `plurnk-bench` evidence in the issue.

## Reviews and reports

State the problem, tradeoffs, verification, and compatibility effect. Reports need
provenance, a minimal reproduction, expected/actual behavior, and sanitized logs.
See [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md) and [SECURITY.md](./SECURITY.md).
