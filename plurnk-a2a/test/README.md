# A2A conformance evidence

| Layer | Subject | What it proves |
|---|---|---|
| Package integration tests | Independent demo actors using the official SDK | Discovery, binding, lifecycle and resource translation against a reference peer. |
| Core `A2a.*.test.ts` | Real daemon, persistence, Mock inference | The adapter drives ordinary Workers and Loops; literal HTTP tests do not reuse Plurnk's client or request builders. |
| Core `A2a.media.test.ts` | Remote SDK peer → daemon → READ → capturing provider | Received Message/Artifact media becomes exact native parts or scoped bytes; offline retention and log curation use ordinary Core behavior. |
| Upstream TCK | Independent Python HTTP+JSON client against that same real daemon | External conformance assertions and their remaining gaps, with unmodified reports. |

## Run the upstream checker

Prerequisites: `uv`, Git, and the normal installed monorepo dependencies. Python
is test tooling, not an installed Plurnk dependency. Use a separate checkout:

```sh
git clone https://github.com/a2aproject/a2a-tck.git /tmp/a2a-tck
git -C /tmp/a2a-tck checkout --detach 263b9cfaf16a554bdfb166a7ba5b67716e946349
npm run test:a2a:tck -w @plurnk/plurnk-service -- /tmp/a2a-tck
```

The runner checks the revision and tracked-file cleanliness, starts a temporary
Core daemon on a loopback ephemeral port, runs all HTTP+JSON requirement tiers, then
stops its daemon. Inference is deterministic and free. It does not use or
restart the operator's daemon. Each run retains the database, service log,
checker output, JSON/HTML/JUnit reports, command, and source/spec revisions in
`~/benchmarks/a2a-tck-*`. A nonzero checker result remains nonzero.

## Interpretation

Read individual failures **and skips**, not the compatibility percentage. The
TCK's requirement aggregate also counts requirements not exercised by this
transport/tier. A skipped prerequisite is not a passing lifecycle test.

The pinned TCK vendors specification revision
`173695755607e884aa9acf8ce4feed90e32727a1`, from March 2026. Its content-type and
error-status assertions differ from the later [official SDK 1.1.0](https://github.com/a2aproject/a2a-js/blob/v1.1.0/CHANGELOG.md): it expects
`application/json`, 415 for unsupported content, and 409 for uncancellable
Tasks, where the SDK uses `application/a2a+json` and 400. Its `CORE-SEND-003`
scenario requests an error but omits `expected_error`, so the generic test
requires success. Compare each assertion with the
[upstream protocol](https://github.com/a2aproject/A2A/blob/main/docs/specification.md)
before changing the adapter. Do not patch
the checker or count these assertions as passing.

The deterministic provider supplies text completion, text Artifacts, and
input-required interactions, including repeated history exchanges. It does not
manufacture binary/data Artifacts or direct Message responses outside Core to
make those scenarios pass. Binary/data delivery remains a product gap; direct
Message responses are an optional protocol branch, whereas inbound Plurnk work
consistently creates Tasks. Neither is claimed as exercised. Follow investigation in #663,
binary translation in #702, and complete Message history in #705. Nonblocking
SDK event processing can outlive HTTP and executor completion; the reconnect
witness does not establish shutdown safety (#704). Current behavior belongs to
{§a2a-inbound-exposure} and {§a2a-resource-projection}.
