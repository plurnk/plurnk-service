# Metaproject agentic-readiness gate

This is an opt-in milestone qualification for using PLURNK to develop the complete
PLURNK primary monorepo. It is intentionally expensive: a fresh campaign semantically
prepares the complete monorepo before asking a floor model to orient
itself through the outside client. Execute it when the focused package, integration,
demo, live-model, and modest-candidate paths are already healthy—not as a routine
debugging loop or ordinary release gate.

Invoke it with:

```sh
npm run readiness:metaproject -- --model <alias> --requiem --preserve
```

This gate does not replace the evidence ladder that qualifies it:

1. Deterministic package and integration coverage proves owned contracts.
2. An assembled modest-repository candidate smoke proves the production client
   and daemon can work together.
3. Focused `live/demo` stories are toy tasks that establish the system is sane
   enough to test seriously.
4. The separate bench lane runs real third-party agentic benchmarks and preserves
   their digest, reasoning, and requiem evidence.
5. Only after those layers are healthy does this full-monorepo campaign ask whether
   PLURNK is ready to develop PLURNK itself.

The gate belongs to `plurnk-meta` because it crosses family ownership: canonical service installation, optional-provider assembly, the outside client, project membership, AG-UI, proposal review, model routing, persistence, and forensic digestion.

## Preconditions

- A clean canonical `plurnk-service` checkout with its gate green.
- The outside `plurnk` client checkout built from its repository head.
- Every default-installed optional provider resolvable from the daemon.
- A project root inside the primary monorepo, with its automatic root `AGENTS.md`.
- One inexpensive capable model alias and, optionally, one local smoke-test alias.

Missing preconditions are RED outcomes. The runner never silently skips a phase.

## Contract

One campaign must prove all of the following through production client and AG-UI surfaces:

1. **Clean bootstrap.** Start from a new database, boot the canonical daemon, and create a user-named workspace.
2. **Membership.** Automatic Git membership completes; `FIND **` succeeds and the canonical `plurnk-service/AGENTS.md` is readable.
3. **Automatic doctrine.** The project-root `AGENTS.md` appears in the model system packet without an explicit pick.
4. **Client YOLO (`--yolo`).** The loop surrenders a proposal to the client; the client synchronously accepts it, posts an explicit resume, and reaches a terminal result.
5. **Loop auto (`--auto`).** Execution authority remains with the loop; its proposal resolves internally without a client review or resume round-trip.
6. **Human review.** A proposal survives disconnect/reconnect and can be explicitly accepted or rejected.
7. **Model hot-swap.** Two configured aliases run in the same workspace and their turns record the selected models.
8. **Restart/resume.** After a daemon restart against the same database, the named workspace and worker retain their context and can complete another loop.
9. **Comprehension.** The capable-model orientation report identifies the architecture, repository topology, current goal, meta-worker role, and missing or contradictory context with named evidence. Writing memory without delivering the requested report is RED.
10. **Forensics.** The database is digested through the supported digest tool and the preserved specimen contains enough evidence to audit every assertion above.

Passing individual package tests or receiving HTTP 200 is insufficient. The user-visible client must remain usable and the requested terminal deliverable must be present.

## Evidence

Each campaign atomically claims `benchmarks/run<N>-dogfood/` and writes:

- `workspace` — workspace and worker names;
- `service.stdout.log` and `service.stderr.log`;
- `phases.json` — command, timing, exit status, and assertion results without secrets;
- `plurnk.db` — the preserved database;
- `digest/` — `digest.md`, `digest.json`, `reasoning.md`, and packet sections;
- `requiem/` when an active provider is available.

The database is evidence, never the diagnostic interface. Assertions consume client output, AG-UI events, and digest artifacts.

## Posture

- Execute in the foreground and fail hard.
- Report client YOLO and loop auto separately; they are different state machines at different ownership boundaries.
- Preserve both passing and failing specimens until explicitly curated.
- Never reuse a database for a clean-bootstrap comparison.
- A provider/configuration/install failure is a gate failure, not a skipped model test.
- File every cross-family defect on `plurnk/plurnk-service` with its owning lane label and specimen path.
