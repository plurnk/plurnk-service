# @plurnk/plurnk-schedule

Scheduled messages for [Plurnk](https://github.com/plurnk/plurnk-service)
workers, on RFC 5545 recurrence rules. A rule delivers its message to a
worker at each occurrence, as an ordinary message from `schedule://<alias>`;
the worker's live loop takes it, or a new loop starts. Workers manage their
own rules through the `schedule` family (`discover`, `add`, `list`, `enable`,
`disable`, `remove`); the operator can seed rules from the environment.

## Configure

Put overrides in the shell, `./.env`, or `$XDG_CONFIG_HOME/plurnk/.env`:

```dotenv
TZ=America/New_York
PLURNK_SCHEDULE_HEARTBEAT={"rule":"FREQ=HOURLY","target":"worker://plurnkbot","prompt":"Check for new messages and report."}
PLURNK_SCHEDULE_ENABLED=["heartbeat"]
```

- `TZ` is the zone rules are read in and the time is told in. The package
  defaults it to UTC; the shell overrides; a workspace overrides through the
  `env` family.
- `PLURNK_SCHEDULE_<ALIAS>` is one definition as JSON: `rule`, `target`
  (`worker://<name>`), `prompt`, and optionally `policy`
  (`{"proposals":"accept"}` for a loop nobody watches). A service rule may be
  unbounded; a rule a worker adds carries `COUNT` or `UNTIL`. Without a
  `DTSTART` a service rule starts when the daemon starts: `FREQ=HOURLY` is a
  check-in at start and every hour after; `BYHOUR`, `BYMINUTE` and `BYSECOND`
  pin a time of day instead.
- `PLURNK_SCHEDULE_ENABLED` names the aliases a workspace starts with.

## Behaviour

- No packet carries a clock; a worker reads the time through `discover`.
- One armed occurrence per rule. A late fire delivers once and skips what it
  missed.
- Timers outlive a workspace's residency and re-arm at daemon start from the
  persisted family state.
- A delivery that fails, because the target worker is gone, lists the rule
  `unavailable` with its Problem; `enable` retries.
- `WAIT (schedule:///rules/<alias>)` holds one pending occurrence in the loop.
  Other arrivals do not erase that attachment. Delivery or withdrawal settles
  it; later recurrences remain independent. READ or KILL its returned
  `schedule:///waits/<id>` resource without changing the shared rule.

`SPEC.md` is the specification; `docs/schedule.md` is the model-facing
teaching beneath the generated family document.
