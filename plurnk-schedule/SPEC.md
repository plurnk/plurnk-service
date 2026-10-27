# Plurnk schedule specification

## §schedule-family 1. Schedule Family and Daemon Module

Scheduled messages are one workspace Functionality family named `schedule`, owned by `@plurnk/plurnk-schedule` ({§functionality-adapter}) and discovered as a daemon module via `package.json#plurnk` ({§module-lifecycle}).

- **Module lifecycle**: Its factory reads package configuration ({§module-contract}); `setup` registers the family adapter before durable lifecycle recovery, and `start` arms persisted rules ({§schedule-residency}). It claims no HTTP mounts.
- **Definition & verbs**: A definition is `{ rule, target, prompt }`: RFC 5545 rule text ({§schedule-rule}), a `session://<name>` target in the workspace ({§path-syntax}, preserved exactly), and the prompt delivered at each occurrence ({§schedule-delivery}). Aliases use the shared lowercase-hyphen grammar. Coordinator verbs: `list`, `discover`, `add`, `replace`, `enable`, `disable`, `remove`. The runtime document's authored body is `docs/schedule.md` ({§functionality-model-projection}).

## §schedule-rule 2. Rule Text, Bounds, Zone, and Clock

| Aspect | Contract |
| --- | --- |
| RFC 5545 rule text | Optional `DTSTART` line, exactly one `RRULE` line (`RRULE:` prefix optional on bare `FREQ=…`), and any `EXDATE` or `RDATE` lines. Refuses by name what the recurrence library would drop silently: an RRULE part outside the 14 RFC 5545 names, a second `RRULE`, a second `DTSTART`, or any other line. Admission stores canonical text (`DTSTART;TZID=<zone>:<local>`, `RRULE:<parts>`, then date lines). |
| Bounds & exhaustion | A workspace rule's RRULE must carry `COUNT` or `UNTIL` (else refuses with `rule-unbounded`); a service rule may be unbounded. An exhausted rule stays listed `active` with `exhausted: true`, `next: null`, and `; no future occurrences` appended to its `text` description, arming nothing. |
| Zone (`TZ`) | Defaults to `TZ=UTC` in `.env.defaults`, overridden by operator env, workspace `env` family ({§execution-output-identity}), and session `env` overrides ({§functionality-coordinator}). Unknown zones refuse with `zone-unknown`. A rule keeps the zone stamped at `add`. Without `DTSTART`, a rule starts at the next whole second in the effective zone (at `add` for workspace rules; at daemon start for service rules). Floating `DTSTART` uses the effective zone; `TZID` or UTC `Z` keeps its own zone. |
| Clock & preview (`discover`) | No packet carries a clock. `discover` with rule text in `source` ({§functionality-replacement}) persists nothing and returns one inert candidate whose summary opens with the current time in the effective zone (RFC 9557, to the second), states the rule in words, and previews its next `PLURNK_SCHEDULE_PREVIEW_OCCURRENCES` occurrences (a positive integer family control, never read as a rule alias), with the canonical rule text in its definition. |

## §schedule-delivery 3. Delivery and First Arming

The module holds one armed occurrence per enabled `(workspace, alias)`. At the occurrence it resolves the target session by name and delivers the prompt through `ApplicationPort.runLoop` with source `schedule://<alias>` (carrying no approval authority; the receiving session retains its owner, {§session-ownership}), refreshing family outcomes when the workspace is resident.

- **Loop interaction**: Joins the session's live loop (waking it if parked) or starts a new loop ({§message-arrival}). Future occurrences are not live work for WAIT ({§loop-completion}).
- **Cursor & first arming**: `add`/`replace` records the admission instant as the first arming cursor ({§functionality-adapter}), so an occurrence falling between admission and preparation still arms, fires at once, delivers once, and appears as `next` in the receipt; rejected or identical replacements do not reset the live timer. After first arming and on daemon start, the present is the cursor (a late fire delivers once and skips missed occurrences, never a backlog).
- **Delivery failure**: A missing session or refused delivery disarms the rule and lists it `unavailable` with the Problem; `enable` or replacement retries and clears the failure on successful publication.

## §schedule-residency 4. Residency, Environment, and Problems

- **Residency**: Cooling a workspace leaves its timers armed; `disable` and `remove` disarm through the published rule set. At daemon start the module obtains each workspace's effective definitions via the coordinator's passive `list` ({§functionality-inspection}) and arms enabled rules whether resident or not.
- **Environment**: `PLURNK_SCHEDULE_<alias>` holds one complete JSON definition ({§env-knob}); `PLURNK_SCHEDULE_ENABLED=1` arms service rules by default, and `<alias>_ENABLED=0` retains a rule without arming it. Construction and offline validation ({§operator-config-precedence}) normalize and validate every definition including disabled ones. Service definitions cannot be removed in a workspace ({§functionality-coordinator}).

| Problem code | Status | Contract |
| --- | --- | --- |
| `alias-required` | 400 | schedule definition needs an alias. |
| `definition-invalid` | 400 | The schedule definition is invalid. |
| `rule-invalid` | 400 | The rule of '*alias*' is unreadable: *cause*. |
| `rule-unbounded` | 400 | A workspace rule ends: give the RRULE a COUNT or an UNTIL. |
| `zone-unknown` | 400 | Unknown time zone. |
| `authority-invalid` | 400 | Schedule resources use an empty authority. |
| `target-missing` | 404 | No session named '*name*' exists in this workspace. |
| `not-found` | 404 | The schedule resource does not exist. |
| `delivery-failed` | 502 | Delivering the scheduled message '*alias*' failed. |
