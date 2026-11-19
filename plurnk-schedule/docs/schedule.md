# schedule

Schedules manage recurring rules, one-shot timers, and unscheduled obligations (`rule: null`) with lifecycle `open`, `done`, or `fail`. Items either wake/create `target` (`session://<name>`, optional `persona`) with `prompt` or execute a deterministic `_plurnk` statement block (`run`) with zero model inference.

| `schedule` arguments | Effect |
| --- | --- |
| `{}` | List obligations and schedules with `status` (`open`, `done`, `fail`), `kind` (`prompt`, `run`), `rule`, `next`, `lastFiredAt`, `doneAt`, and `loopId`. |
| `{"discover": true}` | Return the current time in the effective `TZ` without persisting anything. |
| `{"discover": "+15m"}` | Return current time and preview occurrences of `<rule>` (cron, `RRULE`, ISO-8601 timestamp, or `+duration` / `PT...`). |
| `{"name": "daily", "rule": "0 9 * * *", "target": "session://triage", "prompt": "..."}` | Arm an agentic schedule (auto-creates `session://triage` if absent; optional `"persona"`). |
| `{"name": "sync", "rule": "*/15 * * * *", "run": "mcp({ server: \"plurnk\", tool: \"sh\", arguments: { command: \"...\" } })"}` | Arm a scripted non-model `_plurnk` schedule (`rule: null` stores an unscheduled action/obligation). |
| `{"name": "sync", "run": true}` | Trigger `<name>` immediately on demand. |
| `{"name": "todo-1", "status": "done"}` | Mark an obligation `done` (`open` reopens; `remove: true` dismisses). |
| `{"name": "daily", "enabled": false}` | Disarm (`false`) or re-arm/retry (`true`) an item. |
| `{"name": "daily", "remove": true}` | Dismiss and remove a workspace schedule or completed obligation. |

- `rule`: `null` (unscheduled obligation), `+30s` / `+15m` / `+2h` / `+1d` / `PT15M`, ISO-8601 timestamp (`2026-11-18T09:00:00Z`), 5-field cron (`min hour dom month dow`), or RFC 5545 `DTSTART`/`RRULE`.
- One-shot and `rule: null` obligations remain visible as `status: "done"` once fulfilled until explicitly removed; daily/slower and one-shot schedules default to `catchup: true` across daemon restarts.
