# Package release intent

Add a Changeset with each change that needs a package release:

```sh
npm exec changeset -- --patch @plurnk/plurnk-hooks -m "Describe the correction."
```

Choose `--minor` for compatible functionality and `--major` for an incompatible
public contract. Name the service too when the assembled platform gains a
feature or breaks its public contract; dependency-only bumps cannot infer that
intent. Tests and repository tooling alone do not require an npm release.

Changesets owns version calculation and per-package changelogs. There are no
fixed or linked groups. Compatible peer ranges remain unchanged; our pinned
CLI's behavior is exercised by `scripts/release-version.test.mjs`, including
the upstream option that controls peer-range updates. Exact dependency pins
require consumer updates; compatible ranges do not force a consumer release.

See {§package-release-contract} for the contract and `AGENTS.md` for the release
workflow. Preparation and publication are separate steps.
