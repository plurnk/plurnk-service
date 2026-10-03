# Delegation and messages

## Summary

WORK, FORK, SEND, WAIT, and KILL coordinate workers and their obligations.

## Delegation

WORK starts a fresh log with the task body as its prompt; FORK copies your
history and named scratch into the new name, then diverges. Embedded addresses
are preserved verbatim. Both share the workspace. An omitted address allocates
a short worker name, reported in the receipt; an explicit name cannot replace
an existing worker, even after it finishes. Names match
`[A-Za-z0-9][A-Za-z0-9_-]{0,62}` and are case-sensitive. SEND to an existing
worker gives it a follow-up task.

```WORK (worker://child) [{"env":{"LANG":"C.UTF-8"}}] <!-- fresh log -->
The child's complete task goes here.
```

`env` occupies the header's `[metadata]` slot after the worker address; the
body is the child's task, not a JSON options object. On WORK and FORK these
values override the child's inherited environment (`env.md`).

```FORK (worker://exampleWorkerName) <!-- a child that begins with your history -->
The child's task, continuing from what you already know.
```

```SEND (worker://child) <!-- follow-up to the existing worker -->
The follow-up task or additional information goes here.
```

Parents observe a direct child's mutations, messages, executor invocations, and
worker launches, including failed actions, as rows in their own log.
Exploration and context curation (NOTE, READ, FIND, BARE, WAIT, and log KILL)
stay with the child, including READs of executor output. These observations
never wake the parent; replies and child conclusions retain their ordinary
delivery and wake behavior.

## Lifecycle

Ordinary operations keep the loop working while children run; WAIT joins their
activity. With live work (a child or an open stream) the loop parks and wakes
when that work settles, when a message arrives, or when the wait duration expires;
without live work it continues at once. `WAIT <600>` waits at most ten minutes;
bare WAIT uses the configured default. Expiry resumes inspection without
cancelling work. Several WAITs are one park with the earliest bound. An optional
path is a label, not a selected wake source.

```WAIT
```

A wake ends the suspension, not its held work; a further WAIT waits again.
Waking retains the loop's messages, turn allowance, and remaining execution
time; parked time does not consume execution time. A turn containing only a
parameterless KILL requests completion: its body answers the Open Messages, or
is empty when an already-delivered answer stands. While live work remains, that
KILL joins it without cancelling it and delivers no final answer.

Each child task's conclusion wakes its waiting parent and arrives once, as an
`_plurnk` READ of `ops://exampleWorkerName/1` carrying what the child said: the
execution outcome, not another message, and not delivered again as a reply. A
failure retains its status and Problem. READ that address with a scope to
inspect more of the exact result, even after the child starts another task.
Bare `READ (worker://exampleWorkerName)` collects the current result instead, naming its
exact source in `resource`; while the child is running it returns `425`. A
result does not imply that every task in that worker has finished.

`KILL (worker://<name>)` cancels that worker and its descendants, including
queued work and unread messages. History remains readable; a later SEND can
start new work.

```KILL (worker://child) <!-- cancel this worker's activity -->
```

## Messages

Open Messages names unanswered messages; an arrival receipt's `resource` links
to the same source. SEND to that address answers that message. A targetless
SEND answers your observed Open Messages, or your loop's original message when
none remain open; a concluding parameterless KILL uses the same reply routing
for its body. An empty targetless SEND delivers nothing. SEND to a worker
control address gives it new work instead. Curation of a message's log
occurrences never deletes the source or changes whether it was answered.
Another worker may answer it; the assigned worker and original sender receive
that reply without a new request.

SEND accepts `[{"attachments":["report.pdf","worker:///example.md"]}]`:
send-time copies delivered through ordinary resource links, not native media
injection; the recipient READs what it needs, and a missing source fails before
delivery. The same option works on a targetless reply. A SEND takes no scope;
delivery later or on a cadence is the `schedule` family's, arriving as an
ordinary message from `schedule://<alias>`.
