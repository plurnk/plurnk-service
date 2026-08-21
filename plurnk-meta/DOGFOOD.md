# Metaproject orientation-readiness gate

This opt-in capstone asks a floor model to inspect an assembled open-project
forest through the outside client and deliver an evidence-bearing orientation
report. It is intentionally expensive: a fresh campaign semantically prepares
the complete forest. Execute it only after the focused package, integration,
demo, live-model, and modest-candidate paths are healthy—not as a routine
debugging loop or release gate.

Invoke it with:

```sh
PLURNK_ACCEPTANCE_PROJECT_ROOT=/path/to/open-project-forest \
PLURNK_CLIENT_CHECKOUT=/path/to/open-client \
  npm run readiness:metaproject -- --model <selector> --requiem --preserve
```

Both paths are explicit preconditions. The runner never guesses a sibling
checkout or treats another organization under a shared parent directory as
part of the open project.

This gate does not replace the evidence ladder that qualifies it:

1. Deterministic package and integration coverage proves owned contracts.
2. An assembled modest-repository candidate smoke proves the production client
   and daemon can work together.
3. Focused `live/demo` stories are toy tasks that establish the system is sane
   enough to test seriously.
4. The separate bench lane runs real third-party agentic benchmarks and preserves
   their digest, reasoning, and requiem evidence.
5. Only after those layers are healthy does this full-forest campaign ask whether
   PLURNK is ready to develop PLURNK itself.

The canonical `plurnk-service` checkout owns this gate. Its doctrine lives in
`plurnk-meta` because the report crosses service, contracts, plugins, the
outside client, project membership, AG-UI, model routing, persistence, and
forensic digestion.

## Preconditions

- A clean canonical `plurnk-service` checkout with its gate green.
- The explicit outside open-client checkout built from its repository head.
- Every default-installed optional provider resolvable from the daemon.
- An explicitly assembled open-project forest with its root `AGENTS.md`; shared
  parent directories containing other organizations are not valid substitutes.
- One inexpensive capable model selector and, optionally, one local smoke-test selector.

Missing preconditions are RED outcomes. The runner never silently skips a phase.

## Contract

One campaign proves the following through production client and AG-UI surfaces:

1. **Candidate build.** The exact service and explicit outside-client checkouts build.
2. **Clean bootstrap.** A canonical daemon starts on a new database and the
   client creates a user-named workspace over the explicit forest.
3. **Inspection.** The model performs successful retrievals, including READ,
   before answering and names multiple inspected repository artifacts.
4. **Comprehension.** The report covers service, contracts/DSL, client/AG-UI,
   repository topology, current-work evidence, and confidence-limiting gaps.
   If the canonical forge is unavailable inside the run, it must say that the
   current goal is unverified rather than promote archived GitHub history.
5. **Forensics.** The supported digest captures the database, packet, reasoning,
   usage, and operation evidence used by the deterministic verdict.

Proposal modes, reconnect, model hot-swap, and restart/resume are not asserted
by this executable slice. Expansion of the capstone remains tracked in #3.

Passing individual package tests or receiving HTTP 200 is insufficient. The user-visible client must remain usable and the requested terminal deliverable must be present.

## Evidence

Each preserved campaign atomically claims `benchmarks/run<N>-orientation/` and writes:

- `workspace` — the generated workspace name;
- `prompt.md` — the exact orientation request;
- `client.json` and `client.stderr.log` — the client result and diagnostics;
- `service.stdout.log` and `service.stderr.log`;
- `phases.json` — commands, timings, and exit statuses without secrets;
- `verdict.json` — lifecycle, publication, inspection, evidence, and coverage checks;
- `plurnk.db` — the preserved database;
- `digest/` — `digest.md`, `digest.json`, `reasoning.md`, and packet sections;
- requiem artifacts in `digest/` when `--requiem` is requested.

The database is evidence, never the diagnostic interface. Assertions consume client output, AG-UI events, and digest artifacts.

## Posture

- Execute in the foreground and fail hard.
- Preserve every failing specimen; preserve passing specimens when requested.
- Never reuse a database for a clean-bootstrap comparison.
- A provider/configuration/install failure is a gate failure, not a skipped model test.
- Never infer current work from an archived issue or an uninspected forge reference.
- File every cross-family defect on the canonical forge with its owning lane label and specimen path.
