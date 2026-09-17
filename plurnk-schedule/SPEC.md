# Plurnk schedule specification

## §schedule-family The schedule family

Scheduled messages are one workspace Functionality family named `schedule`,
owned by `@plurnk/plurnk-schedule` ({§functionality-adapter}). A definition is
`{ rule, target, prompt, policy? }`: RFC 5545 rule text ({§schedule-rule}), a
`worker://<name>` target in the workspace ({§worker-name}, preserved exactly), the message delivered at each
occurrence, and optionally the proposal policy of a loop the delivery starts
({§schedule-delivery}). Aliases take the shared grammar. The verbs are the
coordinator's: `list`, `discover` ({§schedule-clock}), `add`, `enable`,
`disable`, `remove`. The adapter publishes no documents of its own; the
family document's authored body is `docs/schedule.md`
({§functionality-model-projection}).

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
`exhausted: true` and `next: null`; it arms nothing.

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
in words, and previews its next three occurrences; the candidate's definition
carries the canonical rule text. Discovery persists nothing; a `query` or a
`configuration` is refused.

## §schedule-delivery Delivery

The module holds one armed occurrence per enabled (workspace, alias). At the
occurrence it resolves the target worker by name and delivers the prompt
through the application port's `runLoop` with the source `schedule://<alias>`
and the definition's policy: the message joins the worker's live loop or
starts one ({§message-arrival}, {§message-causal-source}). The next occurrence
then arms from the present: a late fire delivers once and skips what it
missed, never a backlog. A missing worker or a refused delivery disarms the
rule and lists it `unavailable` with the Problem; `enable` retries. After
every delivery attempt the family's outcomes are refreshed where the workspace
is resident.

## §schedule-residency Residency

A schedule is an obligation, not a runtime. Cooling a workspace leaves its
timers armed; `disable` and `remove` disarm through the published rule set. At
daemon start the module arms every workspace's enabled rules from the
coordinator's persisted family state ({§functionality-state}) over the
service definitions, resident or not; an unreadable definition is reported and
stays disarmed.

## §schedule-environment Environment

`PLURNK_SCHEDULE_<ALIAS>` holds one definition as JSON; the alias is the
suffix case-folded to the family grammar, and two variables folding to one
alias fail at boot. `PLURNK_SCHEDULE_ENABLED` is the JSON array of aliases a
workspace starts with. A service definition is disable-only in a workspace,
as for every family. An explicitly empty definition masks that service rule and
its inherited `ENABLED` selection; it does not remove a workspace-owned rule or
prohibit adding one. Case-fold collisions still fail validation.
