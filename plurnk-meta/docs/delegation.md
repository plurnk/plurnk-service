# Delegation and messages

## Summary

WORK, FORK, SEND, WAIT, and KILL coordinate sessions and their obligations.

## Delegation

WORK starts a fresh log with the task body as its prompt; FORK copies your
history and named scratch into the new name, then diverges. Embedded addresses
are preserved verbatim. Both share the workspace. An omitted address allocates
a short session name, reported in the receipt; an explicit name cannot replace
an existing session, even after it finishes. Names match
`[A-Za-z0-9][A-Za-z0-9_-]{0,62}` and are case-sensitive. SEND to an existing
session gives it a follow-up task.

```WORK (session://child) <!-- fresh log -->
The child's complete task goes here.
```

```FORK (session://exampleSessionName) <!-- a child that begins with your history -->
The child's task, continuing from what you already know.
```

```SEND (session://child) <!-- follow-up to the existing session -->
The follow-up task or additional information goes here.
```

Write `session://child/AGENTS.md` (with EDIT or `COPY (persona://examplePersona/PERSONA.md) (session://child/AGENTS.md)`) before WORK to give a
fresh child session role instructions that its first turn reads automatically;
FORK copies `session://<parent>/AGENTS.md` into `session://<child>/AGENTS.md`
with the rest of your named scratch, and updating `session://<name>/AGENTS.md`
later causes that session's next turn to read the updated instructions.

Parents observe a direct child's mutations, messages, executor invocations, and
session launches, including failed actions, as rows in their own log.
Exploration and context curation (NOTE, READ, FIND, BARE, WAIT, and log KILL)
stay with the child, including READs of executor output. These observations
never wake the parent; replies and child conclusions retain their ordinary
delivery and wake behavior.

## Lifecycle

Ordinary operations keep the loop working while children run; WAIT joins their
activity. With live work (a child or an open stream) the loop parks and wakes
when that work settles, when a message arrives, or when the wait duration expires;
without live work it does not park. `WAIT [600]` waits at most ten minutes;
bare WAIT uses the configured default. Expiry resumes inspection without
cancelling work. Zero continues immediately. Invalid durations are ignored with
a warning. Several WAITs are one park with the earliest bound. An optional
path is a label, not a selected wake source.

```WAIT
```

A wake ends the suspension, not its held work; a further WAIT waits again.
Waking retains the loop's messages, turn allowance, and remaining execution
time; parked time does not consume execution time. Once all Open Messages have
completion replies, the loop settles after results are observed and held work
finishes. Replies are delivered immediately. NOTE and successful curation do
not require another observation turn; other results may warrant more work or a
corrected reply. No additional operation is needed just to conclude.

Each child task's conclusion wakes its waiting parent and arrives once, as an
`_plurnk` READ of `ops://exampleSessionName/1` carrying what the child said: the
execution outcome, not another message, and not delivered again as a reply. A
failure retains its status and Problem. READ that address with a scope to
inspect more of the exact result, even after the child starts another task.
Bare `READ (session://exampleSessionName)` collects the current result instead, naming its
exact source in `resource`; while the child is running it returns `425`. A
result does not imply that every task in that session has finished.

`KILL (session://<name>)` cancels that session and its descendants, including
queued work and unread messages. History remains readable; a later SEND can
start new work.

```KILL (session://child) <!-- cancel this session's activity -->
```

## Messages

`Open Work`'s `messages` list names unresolved requests; an arrival receipt's `resource` links
to the same source. SEND to that address replies to that message. Without a path,
SEND selects the oldest Open Message; progress leaves it open, completion advances
to the next. With none open, name a recipient explicitly, including for corrections.
`[200]` marks a completed request; `[499]` marks a cancelled
request, without cancelling its session or running work. A SEND without either
code is progress, leaving the request open. An empty completion still resolves
its message while retaining earlier speech. SEND to a session
control address gives it new work instead. Curation of a message's log
occurrences never deletes the source or changes whether it was answered.
Another session may answer it; the assigned session and original sender receive
that reply without a new request.

```SEND (message://exampleSessionName/ab3d5678) [200]
The completed answer to this request goes here.
```

SEND accepts `[{"attachments":["report.pdf","workspace:///example.md"]}]`:
send-time copies delivered through ordinary resource links, not native media
injection; the recipient READs what it needs, and a missing source fails before
delivery. The same option works on a targetless reply and composes with completion as
`[200,{"attachments":["report.pdf"]}]`. A SEND takes no scope;
delivery later or on a cadence is the `schedule` family's, arriving as an
ordinary message from `schedule://<alias>`.
