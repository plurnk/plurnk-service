# Contributing

PLURNK is currently being stabilized. Bug fixes, tests, documentation
corrections, simplification, and compatibility improvements are especially
welcome. Discuss large features or new abstractions in an issue before
implementation.

## Setup

Use Node.js 26 or newer.

```sh
npm ci
npm run build
npm run test:lint
npm run test:unit
npm run test:intg
```

Some integration suites require host tools. Live-model and benchmark tests are
not part of the deterministic contributor gate and must state their external
requirements.

## Forge workflow

PossumTech Gitea is the canonical working forge for maintainer development.
GitHub is the public downstream source, external-contribution, security-report,
and historical surface. A GitHub branch or pull request is not canonical until
the work is accepted into Gitea through the maintained project workflow.

External contributors may continue to use GitHub issues and pull requests.
Maintainers coordinate accepted implementation work and durable development
decisions on Gitea; ordinary maintainer pushes target Gitea only.

## Changes

- Keep a change within the package that owns the behavior.
- Prefer public types, validation, and behavioral tests over prose rules.
- Add a regression test for a defect when practical.
- Remove obsolete compatibility paths instead of extending them.
- Keep documentation focused on current behavior. Design history belongs in
  Git and issue discussions.
- Do not include secrets, private databases, model transcripts, or generated
  artifacts in a change.

Use conventional commit subjects:

```text
fix(core): resume an accepted proposal
docs: correct the development setup
test(agui): cover reconnect after review
```

Reference the owning issue when one exists.

## Pull requests

A pull request should explain:

1. the user-visible or contributor-visible problem;
2. the chosen change and important tradeoffs;
3. how it was verified;
4. any compatibility or migration effect.

Small, complete changes are easier to review than multi-package rewrites.
Maintainers may ask that an architectural change be split from mechanical
cleanup.

## Reporting bugs

Include the client and daemon provenance lines, the smallest reproduction,
expected and actual behavior, and sanitized logs. For hangs, include the last
observable lifecycle event and whether the daemon remained responsive.

## Conduct and security

Participation is governed by [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).
Security reports follow [SECURITY.md](./SECURITY.md).
