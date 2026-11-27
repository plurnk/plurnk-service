# Plurnk schedule specification

## §schedule-family 1. Schedule Family and Daemon Module

Scheduled timers, reusable manual scripts, and single-shot obligations are one workspace Functionality family named `schedule`, owned by `@plurnk/plurnk-schedule` ({§functionality-adapter}) and composed statically as a daemon module by `@plurnk/plurnk-service` ({§module-lifecycle}).

- **Module lifecycle**: Its factory reads package configuration ({§module-contract}); `setup` registers the workspace-scoped family adapter (`scopes: ["workspace"]`) and `workspace.schedule.{run,status}` actions before durable lifecycle recovery, and `start` arms persisted rules and subscribes to `workspace/created`, `workspace/archived`, `loop/terminated`, and `stream/concluded` so `host`-origin schedules arm across both existing and newly created workspaces ({§schedule-residency}). It claims no HTTP mounts.
- **Dual definitions & verbs**: A definition is either agentic (`{ rule?, target, prompt, persona?, catchup? }`, delivering `prompt` to `session://<name>` and auto-creating the session with optional `persona` when absent) or deterministic (`{ rule?, run, target?, catchup? }`, where `run` is a non-empty array of `{ server, tool, arguments?, aside? }` calls lowered via `lowerClientCalls` at admission — rejecting malformed calls and turn-only verbs `done`, `fail`, `wait`, `plurnk.question`, and `kill log:///...` with `400 run-invalid` — and executed sequentially in `_plurnk` via `ApplicationPort.dispatchClientAction` without model inference). Aliases use the shared lowercase-hyphen grammar. Coordinator verbs: `list`, `discover`, `add`, `replace`, `enable`, `disable`, `remove`, plus `workspace.schedule.run` (`{ alias }`) and `workspace.schedule.status` (`{ alias, status }`). The runtime document's authored body is `docs/schedule.md` ({§functionality-model-projection}).

## §schedule-rule 2. Rule Text, Manual & Once Forms, Zone, and Clock

| Aspect | Contract |
| --- | --- |
| Temporal & untimed forms (`rule`) | `"manual"` (canonical default when `rule` is omitted; arms no timer, stays `open` after execution, callable repeatedly), `"once"` (unscheduled single-shot obligation arming no timer; transitions `open → done` on completion and refuses repeat triggers with `409 already-done` until reopened or changed to `"manual"`), ergonomic one-shot duration (`+<n><s\|m\|h\|d\|w>` or ISO-8601 `P…` / `PT…`), one-shot ISO-8601 / RFC 9557 timestamp (`YYYY-MM-DDTHH:MM[:SS][Z\|±HH:MM][Zone]`, normalized to single-occurrence `DTSTART;TZID=<zone>:<local>\nRRULE:FREQ=SECONDLY;COUNT=1`), 5-field cron (`<min> <hour> <dom> <month> <dow>`, normalized to `RRULE` with `BYSECOND=0`), or RFC 5545 text (optional `DTSTART`, one `RRULE` line, and optional `EXDATE`/`RDATE` lines). Refuses unknown RRULE parts, duplicate `RRULE`/`DTSTART`, or malformed lines. |
| Obligation lifecycle (`open` · `done` · `fail`) | Every enabled item exposes `detail.status` in `open \| done \| fail` alongside `lastFiredAt`, `doneAt`, `lastDoneAt`, and causal `loopId`. `"once"`, one-shot timed, and exhausted obligations transition to `done` (`doneAt` stamped, `next: null`) when their action or session loop settles `200`, remaining visible in `list` until `remove`d or reopened (`open`). `"manual"` and recurring rules stamp `lastDoneAt` and stay `open` (`doneAt: null`). Delivery or execution failures transition to `fail` (`state: "unavailable"` with the Problem) until retried (`enable`, `replace`, or `run`) or removed. |
| Zone (`TZ`) | Defaults to `TZ=UTC` in `.env.defaults`, overridden by operator env, workspace `env` family ({§execution-output-identity}), and session `env` overrides ({§functionality-coordinator}). Unknown zones refuse with `zone-unknown`. |
| Clock & preview (`discover`) | No packet carries a clock. `discover` with `{}` tells the current time in the effective zone (RFC 9557, to the second); with `rule` ({§functionality-replacement}) it persists nothing and returns one inert candidate previewing the next `PLURNK_SCHEDULE_PREVIEW_OCCURRENCES` occurrences and canonical rule text. |

## §schedule-delivery 3. Delivery, Catchup, On-Demand Execution, and Step Receipts

The module holds at most one armed occurrence per enabled `open` `(workspace, alias)` with a timed `rule` and persists a per-workspace ledger (`@plurnk/plurnk-schedule/ledger`) recording `createdAt`, `status`, `lastFiredAt`, `doneAt`, `lastDoneAt`, and `loopId`.

- **Execution modes & receipts**: Agentic (`prompt`) schedules resolve `session://<name>` (auto-creating the session when absent; refusing archived sessions with `409 target-archived`) and deliver via `ApplicationPort.runLoop` with source `schedule://<alias>`, settling obligation status on `loop/terminated`. Scripted (`run`) schedules dispatch lowered `PlurnkStatement[]` sequentially in `_plurnk` via `ApplicationPort.dispatchClientAction` with actor `schedule://<alias>`, awaiting any `102` execution stream conclusion (`stream/concluded`), stopping at the first step `>= 400`, and returning compact per-step `results` (`{ index, server, tool, status, uri?, preview?, problem? }`) on `workspace.schedule.run`.
- **Cursor, first arming & `catchup`**: `add`/`replace` records the admission instant as the first arming cursor. `catchup` defaults to `true` for one-shot (`COUNT=1`) and daily-or-slower (`DAILY`, `WEEKLY`, `MONTHLY`, `YEARLY`) rules and `false` for sub-daily rules (overridable per definition): when `true`, arming after sleep or restart queries `nextOccurrence` from `lastFiredAt ?? createdAt` so missed windows fire once immediately without replaying a backlog.
- **On-demand triggering, inspection & `status`**: `workspace.schedule.run` (`plurnk.schedule({ alias, trigger: true })`, with RENO tolerance for boolean `run: true`/`fire: true`/`execute: true`/`invoke: true`) executes `<alias>` immediately as a `host` effect (refusing completed `"once"` obligations with `409 already-done`), bare `{ alias }` inspects read-only with `{ family: "schedule", alias, executed: false, hint, definition }`, and `workspace.schedule.status` (`plurnk.schedule({ alias, status })`) transitions obligation state (`open`, `done`, `fail`).
- **Concurrency & re-entrancy**: Each `(workspace, alias)` permits at most one active delivery at a time. Concurrent or re-entrant `workspace.schedule.run` calls (including direct or mutual schedule recursion) are refused with `409 already-running` without disturbing the active delivery or its ledger state; an armed timer firing while the same `(workspace, alias)` is already delivering skips overlapping execution and re-arms the next occurrence.

## §schedule-residency 4. Residency, Environment, and Problems

- **Residency**: Cooling a workspace leaves its timers armed; archiving a workspace disarms its timers while preserving its ledger until unarchived; `disable` and `remove` disarm through the published rule set (`remove` clears the ledger entry). At daemon start the module syncs every unarchived workspace's enabled definitions.
- **Environment**: `PLURNK_SCHEDULE_<alias>` holds one complete JSON definition ({§env-knob}); `PLURNK_SCHEDULE_ENABLED=1` arms host-origin rules by default, and `<alias>_ENABLED=0` retains a rule without arming it.

| Problem code | Status | Contract |
| --- | --- | --- |
| `alias-required` | 400 | schedule definition needs an alias. |
| `definition-invalid` | 400 | The schedule definition is invalid. |
| `run-invalid` | 400 | A scheduled tool call could not be lowered or uses a turn-only verb. |
| `rule-invalid` | 400 | The rule of '*alias*' is unreadable: *cause*. |
| `zone-unknown` | 400 | Unknown time zone. |
| `authority-invalid` | 400 | Schedule resources use an empty authority. |
| `not-found` | 404 | The schedule resource does not exist. |
| `target-missing` | 404 | No session named '*name*' exists in this workspace (when session creation is unavailable). |
| `already-done` | 409 | Completed `"once"` obligation cannot be triggered again until reopened or switched to `"manual"`. |
| `already-running` | 409 | Schedule '*alias*' is already running in this workspace (guards re-entrant and overlapping triggers). |
| `target-archived` | 409 | Session '*name*' is archived. |
| `delivery-failed` | 502 | Delivering the scheduled item '*alias*' failed. |
