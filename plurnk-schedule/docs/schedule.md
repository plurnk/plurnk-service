# schedule

A schedule delivers a message to a worker at each occurrence of a recurrence
rule. The rule is RFC 5545 text, the `RRULE` grammar calendars use, and the
message arrives like any other, from `schedule://<alias>`, joining the
worker's live loop or starting one. Your packet carries no clock: `discover`
tells the time when you ask.

## When to reach for a schedule

- Work that recurs on the calendar: a daily summary, an hourly check, one
  reminder at a set time.
- Something external to wait for that sends no signal: schedule the check
  instead of polling from inside a loop.
- Not for a child worker or a task you started: those wake you when they
  conclude.

## discover: read the time, preview a rule

`discover` takes `{"source": "<rule text>"}` and returns one inert candidate.
Its summary opens with the current time in the effective zone and previews
the first occurrences; its definition carries the rule as it would be stored.
Nothing is persisted.

````schedule (discover) <!-- what time is it, and when would this fire -->
{"source": "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0;COUNT=20"}
````

## add

`add` persists the rule for this workspace and arms it. It is a host
effect: it proposes and runs only on acceptance.

````schedule (add)
{"alias": "standup", "definition": {"rule": "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0;COUNT=20", "target": "worker://scribe", "prompt": "Summarize yesterday's log entries for the team."}}
````

- `rule`: bare `FREQ=…` parts, or a `DTSTART` line and an `RRULE` line. A
  workspace rule ends: give it `COUNT` or `UNTIL`. Without a `DTSTART` the
  rule starts at the next whole second when added; `BYHOUR`, `BYMINUTE`,
  `BYSECOND` and `BYDAY` place it.
- `target`: the worker that receives the message, `worker://<name>`; any
  worker in this workspace, yourself included.
- `prompt`: the message delivered at each occurrence.
- `policy`: `{"proposals": "accept"}` when the delivery starts a loop no one
  is watching and it must act on its own proposals; absent, the worker's
  default holds.

Times are read in `TZ`: the workspace's `env` family sets it for every rule
and every command; UTC otherwise.

## list, enable, disable, remove

`list` shows each rule with its zone, its wording, and its next occurrence,
or `exhausted` once it has run out. A rule that could not deliver, because its
worker is gone, is `unavailable` with the exact Problem; `enable` retries it.
`disable` disarms without forgetting; `remove` forgets.

## Receiving a scheduled message

It arrives as an open message from `schedule://<alias>`, in the loop you are
in or in a new one. Answer it as you would any message.
