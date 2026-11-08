# schedule

A schedule delivers a message from `schedule://<name>` to `target` (`session://<name>`) at each occurrence of an RFC 5545 `RRULE` in `TZ` (from `plurnk.env`, or UTC). The packet carries no clock; `discover` reports current time.

| Call | Effect |
| --- | --- |
| `await plurnk.schedule({});` | List rules with time zone, summary, status (`active`, `exhausted`, `unavailable`), and next occurrence. |
| `await plurnk.schedule({ discover: true });` | Return the current time in the effective zone without persisting anything. |
| `await plurnk.schedule({ discover: "<rule>" });` | Return the current time and preview the first occurrences of `<rule>` without persisting. |
| `await plurnk.schedule({ name, rule, target, prompt });` | Persist and arm a workspace schedule (host effect). |
| `await plurnk.schedule({ name, enabled: false });` | Disarm (`false`) or re-arm/retry (`true`) a rule. |
| `await plurnk.schedule({ name, remove: true });` | Remove a workspace rule. |

await plurnk.schedule({ discover: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0;COUNT=20" }); // current time and occurrence preview

await plurnk.schedule({ name: "daily", rule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0;COUNT=20", target: "session://exampleSessionName", prompt: "Text delivered at each occurrence." });

await plurnk.schedule({ name: "once", rule: "FREQ=SECONDLY;COUNT=1", target: "session://main", prompt: "One-time reminder." }); // omit DTSTART to start at the next whole second

- `rule`: bare `FREQ=…` parts, or optional `DTSTART` + `RRULE`. Workspace rules must bound occurrences with `COUNT` or `UNTIL`. Omit `DTSTART` on relative rules so they start at the next whole second when added.
- Scheduled messages arrive as Open Messages from `schedule://<name>`, waking a parked session or starting a loop, and are answered with `plurnk.done` / `plurnk.fail` / `plurnk.send`.
