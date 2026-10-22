# A2A conformance evidence

| Layer | Subject | What it proves |
|---|---|---|
| Package integration tests | Independent demo actors using the official SDK | Discovery, binding, lifecycle and resource translation against a reference peer. |
| Core `A2a.*.test.ts` | Real daemon, persistence, Mock inference | The adapter drives ordinary Workers and Loops; literal HTTP tests do not reuse Plurnk's client or request builders. |
| Core `A2a.context.test.ts` | Related Tasks with independent Workers | Sibling lifecycle isolation, retained Context history and media after curation, opaque Context identities, and unchanged historical Task evidence. |
| Package observation tests and Core HTTP tests | Concurrent requests over durable Tasks | Independent initial snapshots, completion during admission/read/cancellation, exact-Loop continuation, and observer cleanup. |
| Core `A2a.media.test.ts` | Remote SDK peer → daemon → READ → capturing provider | Received Message/Artifact media becomes exact native parts or scoped bytes; offline retention and log curation use ordinary Core behavior. |
| Upstream TCK | Independent Python HTTP+JSON client against that same real daemon | External conformance assertions and their remaining gaps, with unmodified reports. |

## Run the upstream checker

Prerequisites: `uv`, Git, and the normal installed monorepo dependencies. Python
is test tooling, not an installed Plurnk dependency. Use a separate checkout:

```sh
git clone https://github.com/a2aproject/a2a-tck.git ../a2a-tck
git -C ../a2a-tck checkout --detach 263b9cfaf16a554bdfb166a7ba5b67716e946349
PLURNK_MODEL=<selector> npm run test:live -- --specimen "live a2a: the upstream TCK's HTTP+JSON requirement tiers find only the ruled divergences in the assembled daemon"
```

The checker is a live specimen ({§tier-census}): it runs in every live tier whose
host has `uv` and the pinned checkout beside the repository (or at
`PLURNK_A2A_TCK_CHECKOUT`), and skips by name otherwise. It asserts the revision
and tracked-file cleanliness, starts a temporary Core daemon on a loopback
ephemeral port, runs all HTTP+JSON requirement tiers, then stops its daemon.
Inference is deterministic and free. It does not use or restart the operator's
daemon. Each run retains the database and digest, service log, checker output,
JSON/HTML/JUnit reports, command, source/spec revisions and its `rulings.json` verdict in its run
directory under the tier's `$PLURNK_BENCHMARKS/tier-live-<stamp>/` (`~/benchmarks` when unset).

## Interpretation

The specimen reads the JUnit report, not the exit code or the compatibility percentage: it requires exactly the
failures {§a2a-tck-rulings} rules on, each for its ruled reason, and an explained reason for every skip. A skipped
prerequisite is not a passing lifecycle test, so a skip the rulings do not explain fails the specimen too. Its
`rulings.json` names any unruled failure, any ruled failure that now passes, any failure with another reason, and
any unexplained skip; settle each against the [upstream protocol](https://github.com/a2aproject/A2A/blob/main/docs/specification.md)
and update the rulings with the specimen. Do not patch the checker.
