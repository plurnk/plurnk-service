# schedule

Schedules manage recurring rules, one-shot timers, reusable manual scripts (`rule: "manual"`, the default when omitted), and single-shot unscheduled obligations (`rule: "once"`) with lifecycle `open`, `done`, or `fail`. Items either wake/create `target` (`session://<name>`, optional `persona`) with `prompt` or execute an ordered `_plurnk` tool-call array (`run`) with zero model inference and per-step receipts.

| `schedule` arguments | Effect |
| --- | --- |
| `{}` | List obligations and schedules with `status` (`open`, `done`, `fail`), `kind` (`prompt`, `run`), `rule`, `next`, `lastFiredAt`, `doneAt`, and `loopId`. |
| `{"alias": "sync"}` | Inspect one schedule read-only (`executed: false`; `404` when absent). |
| `{"discover": true}` | Return the current time in the effective `TZ` without persisting anything. |
| `{"discover": "+15m"}` | Return current time and preview occurrences of `<rule>` (cron, `RRULE`, ISO-8601 timestamp, or `+duration` / `PT...`). |
| `{"alias": "daily", "rule": "0 9 * * *", "target": "session://triage", "prompt": "..."}` | Arm an agentic schedule (auto-creates `session://triage` if absent; optional `"persona"`). |
| `{"alias": "sync", "run": [{"server": "plurnk", "tool": "sh", "arguments": {"command": "..."}}]}` | Save a reusable `"manual"` scripted `_plurnk` action (omit `rule` or set `"manual"` for reusable triggers; set `"once"` for single-shot, or a timed rule). |
| `{"alias": "sync", "trigger": true}` | Execute `<alias>` immediately on demand and return compact per-step `results` for scripted runs. |
| `{"alias": "todo-1", "status": "done"}` | Mark an obligation `done` (`open` reopens; `remove: true` dismisses). |
| `{"alias": "daily", "enabled": false}` | Disarm (`false`) or re-arm/retry (`true`) an item. |
| `{"alias": "daily", "remove": true}` | Dismiss and remove a workspace schedule or completed obligation. |

- `rule`: `"manual"` (default when omitted; reusable, stays `open`), `"once"` (single-shot; settles `done` and refuses repeat triggers with `409` until reopened), `+30s` / `+15m` / `+2h` / `+1d` / `PT15M`, ISO-8601 timestamp (`2026-11-18T09:00:00Z`), 5-field cron (`min hour dom month dow`), or RFC 5545 `DTSTART`/`RRULE`.
- Turn-only verbs (`done`, `fail`, `wait`, `plurnk.question`, and `kill` on `log:///...`) are refused in `run` arrays at admission (`400 run-invalid`).
- `"once"` and timed one-shot obligations remain visible as `status: "done"` once fulfilled until removed or reopened; daily/slower and one-shot schedules default to `catchup: true` across daemon restarts.
