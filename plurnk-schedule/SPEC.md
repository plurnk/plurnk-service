# Plurnk schedule specification

## §schedule-family The schedule family

Scheduled messages are one workspace Functionality family named `schedule`,
owned by `@plurnk/plurnk-schedule` ({§functionality-adapter}). A definition is
`{ rule, target, prompt }`: RFC 5545 rule text ({§schedule-rule}), a
`worker://<name>` target in the workspace ({§worker-name}, preserved exactly), the message delivered at each
occurrence ({§schedule-delivery}). Aliases take the shared grammar. The verbs are the
coordinator's: `list`, `discover` ({§schedule-clock}), `add`, `enable`,
`disable`, `remove`. The adapter publishes no documents of its own; the
runtime document's authored body is `docs/schedule.md`
({§functionality-model-projection}).

## §schedule-module Daemon module

The package declares itself a daemon module in `package.json#plurnk`, so the host discovers it
({§module-discovery}). Its factory reads this package's configuration ({§module-self-activation});
`setup` registers the family adapter before durable lifecycle recovery, and `start` arms the
coordinator's persisted rules ({§schedule-residency}). It claims no HTTP mounts.

## §schedule-rule Rule text

A rule is RFC 5545 text: an optional `DTSTART` line, exactly one `RRULE` line,
and any `EXDATE` or `RDATE` lines. Bare `FREQ=…` parts are the RRULE line; the
`RRULE:` prefix is optional. The recurrence library owns the grammar and the
expansion. The family refuses by name what the library would drop silently: an
RRULE part outside the fourteen RFC 5545 names, a second RRULE, a second
DTSTART, any other line. Admission stores the library's canonical text,
`DTSTART;TZID=<zone>:<local>` then `RRULE:<parts>` then the date lines, and
every later read parses that text; a canonical text that fails to parse is a
defect, not a refusal.

## §schedule-bound Bound

A workspace rule ends: its RRULE carries `COUNT` or `UNTIL`, else `add`
refuses with `rule-unbounded`. A service rule ({§schedule-environment}) may be
unbounded; the operator owns it. An exhausted rule stays listed `active` with
`exhausted: true` and `next: null`; it arms nothing. Exhaustion states that no
future occurrence exists, not that a message was delivered: a rule may already
be exhausted when added. Its existing `text` description ends with
`; no future occurrences`, in add results and later inspection alike. This is
status, not a failure or a claim of delivery; no dates or wake conditions change.

## §schedule-zone Zone

`TZ` is the zone a rule is read in and the zone the time is told in. The
package declares `TZ=UTC` in `.env.defaults`; the operator's environment
overrides it, a workspace overrides it through the `env` family
({§workspace-env}), and a Worker's own `env` override wins for the verbs that
Worker invokes ({§functionality-scope}). A call carrying `env` metadata with
`TZ` is read in that zone for that call. A rule keeps the zone stamped at its
`add`; a later `env` change moves no existing rule. Without a `DTSTART` a rule starts when it is read, at the
next whole second in the effective zone, so its first occurrence is still
ahead: a workspace rule is read at `add`, a service rule once, when the daemon
starts, in the service's zone. A floating `DTSTART` is read in the effective
zone; a `DTSTART` with a `TZID` or a UTC `Z` keeps its own zone. An unknown
zone refuses with `zone-unknown`.

## §schedule-clock The clock

No packet carries a clock. The time is told on demand: `discover` with rule
text in `source` returns one inert candidate whose summary opens with the
current time in the effective zone (RFC 9557, to the second), states the rule
in words, and previews its next `PLURNK_SCHEDULE_PREVIEW_OCCURRENCES`
occurrences ({§schedule-discovery-preview}); the candidate's definition
carries the canonical rule text. Discovery persists nothing; rule text in
`source` is its one input ({§functionality-discover-advertisement}).

§schedule-discovery-preview `PLURNK_SCHEDULE_PREVIEW_OCCURRENCES` is a family control
like `PLURNK_SCHEDULE_ENABLED`: a positive integer, never read as a rule alias.

## §schedule-delivery Delivery

The module holds one armed occurrence per enabled (workspace, alias). At the
occurrence it resolves the target worker by name and delivers the prompt
through the application port's `runLoop` with the source `schedule://<alias>`.
The message joins the worker's live loop, waking it if parked, or starts a new
loop ({§message-arrival}, {§message-causal-source}). Delivery carries no approval
authority; the receiving worker retains its owner ({§worker-ownership}).
A future occurrence is not live work for WAIT ({§wait-obligation-matrix}); it
neither holds a loop open nor concludes it. The next occurrence
then arms from the present: a late fire delivers once and skips what it
missed, never a backlog. A missing worker or a refused delivery disarms the
rule and lists it `unavailable` with the Problem; `enable` retries. After
every delivery attempt the family's outcomes are refreshed where the workspace
is resident.

§schedule-first-arming **A rule's first arming is judged from its `add`.** `add` reads the
rule at the instant it admits it; preparation and arming come later, and a single
occurrence can fall between. The first arming of an admitted rule takes the admission
instant as its cursor, so that occurrence still arms, fires at once, and delivers once, and
the `add` receipt names it as `next`. The present is the cursor from then on. The admission
is remembered by the running daemon only: a daemon that starts arms every stored rule from
the present, as above.

## §schedule-residency Residency

A schedule is an obligation, not a runtime. Cooling a workspace leaves its
timers armed; `disable` and `remove` disarm through the published rule set. At
daemon start the module obtains each workspace's effective definitions through
the coordinator's passive `list` ({§functionality-inspection}) and arms the
enabled rules, resident or not. Only the coordinator resolves and validates
stored configuration ({§functionality-state}, {§configuration-definition-resolution});
malformed state fails there. An unreadable recurrence is reported and stays disarmed.

## §schedule-environment Environment

`PLURNK_SCHEDULE_<alias>` holds one complete definition as JSON, using
{§resource-environment}. `PLURNK_SCHEDULE_ENABLED=1` arms declared service rules
by default; `<alias>_ENABLED=0` retains a rule without arming it. The family
validates every definition, including disabled rules, at construction. A service
definition cannot be removed in a workspace ({§functionality-coordinator}); live
definitions and state compose through {§configuration-definition-resolution}.
Offline validation uses the same rule normalization as construction, without arming
or persisting a rule ({§operator-config-offline-validation}).

§problems-schedule **Schedule Problems.** Every code minted here, its status, and the sentence that is its contract (placeholders in *italics* are filled at emission; a fixed recovery follows its detail).

| code | status | contract |
|---|---:|---|
| `alias-required` | 400 | schedule add needs an alias. |
| `definition-invalid` | 400 | The schedule definition is invalid. |
| `rule-invalid` | 400 | The rule of '*alias*' is unreadable: *cause*. |
| `delivery-failed` | 502 | Delivering the scheduled message '*alias*' failed. |
| `target-missing` | 404 | No worker named '*name*' exists in this workspace. |
| `rule-unbounded` | 400 | A workspace rule ends: give the RRULE a COUNT or an UNTIL. |
