---
"@plurnk/plurnk-providers": major
"@plurnk/plurnk-contracts": minor
"@plurnk/plurnk-acp": minor
"@plurnk/plurnk-service": minor
---

Scheduler-owned inference lanesmanship, fresh pre-packet admission, timeout
exclusion while queued, and KV-aware session burst/handoff scheduling (`#1549`):

- `@plurnk/plurnk-providers`: Promoted `InferenceAdmission` to a lane scheduler
  returning `InferenceLaneLease` (`release()`, `handoff()`, `suspend()`),
  exposed `Provider.acquireLane` and `Provider.laneGate`, added alias-scopable
  `PLURNK_PROVIDERS_LANE_BURST_MS` (default `300000` ms; `-1` run-to-completion,
  `0` strict FIFO) and `PLURNK_PROVIDERS_LANE_HANDOFF_MS` (default `15000` ms),
  excluded lane-queue wait from `PLURNK_PROVIDERS_OPERATION_TIMEOUT_MS`,
  coordinated local `/v1/chat/completions/input_tokens` and `/tokenize`
  preflights with endpoint admission, and added per-model `429` cooldown pacing.
- `@plurnk/plurnk-service`: Acquired endpoint inference lanes in `LoopDriver`
  before `LoopLifecycle` active execution timing, `WorkspaceGate`, workspace
  derivation, and packet assembly so queued subagents assemble fresh packets,
  never burn `PLURNK_SERVICE_LOOP_TIMEOUT_MS` while queued, and yield inter-turn
  handoff reservations immediately on terminal outcomes, `202` parks, HITL
  proposals/interactions, `BARE`, exec holds, or recovery backoff.
- `@plurnk/plurnk-contracts` & `@plurnk/plurnk-acp`: Routed `engine:turn`
  `turn_queued` notices onto `runtime/telemetry` and ACP `_plurnk_telemetry`
  with live queue position, depth, active count, and lane limit.
