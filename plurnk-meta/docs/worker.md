# `worker://` — workers and their entries

## Summary

Coordinate workers, request isolated BARE inference, and manage workspace entries.

Workers inhabit one workspace. The authority selects a worker; a path selects
an entry rather than controlling that worker.

| Address | Meaning | Model access |
| --- | --- | --- |
| `worker://reviewer` | Named worker | WORK/FORK create; SEND messages; READ collects; KILL terminates. |
| `message://reviewer/ab3d5678` | Retained message | READ/FIND/COPY inspect; SEND replies. Neither EDIT nor KILL changes its source. |
| `ops://reviewer/1` | What that loop said, or how it ended | READ/FIND/COPY inspect; source is immutable. |
| `worker://reviewer/example.md` | Named scratch entry | Read and write from any worker in the workspace. |
| `worker:///example.md` | Shared commons entry | Read and write. |

The packet's `## Worker` block, below the log, names your worker, its parent
(`null` at a root), and the loop and turn you are producing. Addresses are
literal and keep the same meaning when passed to another worker. Scratch
belongs to the workspace; a namespace does not require a namesake worker.
Generated references live under `worker:///_plurnk/`, and reference refreshes
may replace them. EDIT creates or changes an entry, never a worker; KILL with
an entry path deletes that entry, not its worker. A control address is scheme
and authority only: no trailing slash, userinfo, port, query, or fragment.
Messages and loop outcomes have their own addresses; neither is a scratch
entry or an actor control.

An entry whose source has a readable projection (HTML, a notebook) carries it
beside the source as `#readable`, text/markdown, in its own line coordinates;
the default channel stays the source, and a pattern matches the channel it
addresses. The projection follows every source write and is never written
itself.

## Delegation

WORK starts a fresh log with the task body as its prompt; FORK copies your
history and named scratch into the new name, then diverges. Embedded addresses
are preserved verbatim. Both share the workspace. An omitted address allocates
a short worker name, reported in the receipt; an explicit name cannot replace
an existing worker, even after it finishes. Names match
`[A-Za-z0-9][A-Za-z0-9_-]{0,62}` and are case-sensitive. A path outside the
`worker://` scheme is the child's prompt resource, as for BARE:
`WORK (specs/feature.md)` reads the file whole as the task, an inline body
follows it after a blank line, and the child is auto-named. SEND to an existing
worker gives it a follow-up task. `[{"env": {...}}]` on WORK or FORK is the
child's starting environment (`env.md`).

Parents observe a direct child's mutations, messages, executor invocations, and
worker launches, including failed actions, as rows in their own log.
Exploration and context curation (NOTE, READ, FIND, BARE, WAIT, and log KILL)
stay with the child, including READs of executor output. These observations
never wake the parent; replies and child conclusions retain their ordinary
delivery and wake behavior.

## Lifecycle

Ordinary operations keep the loop working while children run; WAIT joins their
activity. With live work (a child or an open stream) the loop parks and wakes
when that work settles, when a message arrives, or on an open stream's
observation cadence; without live work it continues at once. Several WAITs in
one turn are one park, and what a WAIT names is its label; scope and metadata
decorations are ignored.

A wake ends the suspension, not its held work; a further WAIT waits again.
Waking retains the loop's messages, turn allowance, and remaining execution
time; parked time does not consume execution time. A turn containing only a
parameterless KILL requests completion: its body answers the Open Messages, or
is empty when an already-delivered answer stands. While live work remains, that
KILL joins it without cancelling it and delivers no final answer.

Each child task's conclusion wakes its waiting parent and arrives once, as an
`_plurnk` READ of `ops://reviewer/1` carrying what the child said: the
execution outcome, not another message, and not delivered again as a reply. A
failure retains its status and Problem. READ that address with a scope to
inspect more of the exact result, even after the child starts another task.
Bare `READ (worker://reviewer)` collects the current result instead, naming its
exact source in `resource`; while the child is running it returns `425`. A
result does not imply that every task in that worker has finished.

`KILL (worker://<name>)` cancels that worker and its descendants, including
queued work and unread messages. History remains readable; a later SEND can
start new work.

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

## BARE inference

BARE makes one isolated call to the child model, not a persistent worker. It
receives no parent history or tools. Its prompt is a resource, an inline body,
or both; resource text precedes an inline body with a blank line between.

```BARE (worker://reviewer/draft.md)
```
```BARE (worker://reviewer/draft.md)
Assess the argument above; name its weakest step.
```

The resource supplies its complete current READ text, not a preview. Neither
prompt form is truncated to fit; provider capacity still applies. A failed
source read returns its error without making an inference call. Consecutive
BARE calls run concurrently and settle before the turn continues. Their
answers are ordinary BARE receipts, visible in the next packet.

## Turn sources

| Address | Read-only source in the named worker's history |
| --- | --- |
| `ops://<worker>/<loop>/<turn>` | The exact submitted program, including interstitial text. |
| `reasoning://<worker>/<loop>/<turn>` | Original provider reasoning when exposed, or a harness turn's authored rationale. |
| `note://<worker>/<loop>/<turn>/<item>` | The literal NOTE body, from the program or exposed reasoning; the receipt gives its address. |

The worker name is required. Any worker in the workspace can READ these
sources; `log:///` remains your own context. READ brings the selected source
into your log, and KILL of that READ curates only its log projection, never the
original evidence. The current turn's reasoning exists when its OPs execute, so
`READ (reasoning://reviewer/1/3) <1,-1>` from `worker://reviewer` on loop 1,
turn 3 retains it; a turn that produced no reasoning reads empty, and a turn
that has not happened returns a missing-source result. READ never requests
inference. NOTE retains working memory without changing the loop state; only
NOTE also executes from exposed reasoning, while quoted examples and other
reasoned operations remain data. Notes are ordinary log items whose read-only
sources stay searchable (`FIND (note://reviewer/**) /parser/`) and READable
after curation or a FORK.
