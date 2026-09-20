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
in words, and previews its next `PLURNK_SCHEDULE_PREVIEW_OCCURRENCES`
occurrences ({§schedule-discovery-preview}); the candidate's definition
carries the canonical rule text. Discovery persists nothing; a `query` or a
`configuration` is refused.

§schedule-discovery-preview `PLURNK_SCHEDULE_PREVIEW_OCCURRENCES` is a family control
like `PLURNK_SCHEDULE_ENABLED`: a positive integer, never read as a rule alias.

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

## §schedule-await Awaiting one occurrence

`schedule:///rules/<alias>` is the readable rule resource. WAIT on it attaches
its currently armed occurrence under {§awaited-event}; WAIT does not create,
retarget, enable or change the schedule. A missing, disabled, exhausted or
unavailable rule returns its factual failure and creates no attachment.

The attachment resource `schedule:///waits/<id>` is independently readable and
cancellable. KILL there withdraws the attachment, not the rule. A successful
delivery settles all attachments to that exact occurrence after message
admission, not after the recipient finishes answering. Later recurrences are
independent. Repeated WAIT before delivery reuses the same loop attachment.

Rule replacement, disablement and removal settle the affected attachments;
re-enabling does not revive them. Registration, delivery and rule publication
are serialized by the producer so completion cannot fall between resolving
an occurrence and recording its attachment. A future occurrence survives
restart only when the restored rule still identifies it. An overdue occurrence
whose delivery was not recorded is reported as uncertain, not replayed or
silently replaced with the next recurrence.

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
workspace starts with; `[]` is the one spelling of none, and an absent or empty
key is refused by name. A service definition is disable-only in a workspace,
as for every family. An explicitly empty definition masks that service rule and
its inherited `ENABLED` selection; it does not remove a workspace-owned rule or
prohibit adding one. Case-fold collisions still fail validation.
