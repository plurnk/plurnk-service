# `worker://` — workers and their entries

## Summary

Coordinate workers, request isolated BARE inference, and manage workspace entries.

Workers inhabit one workspace. The authority selects a worker; a path selects
an entry rather than controlling that worker.

| Address | Meaning | Model access |
| --- | --- | --- |
| `worker://reviewer` | Named worker | WORK/FORK create; SEND messages; READ collects; KILL terminates. |
| `message://reviewer/ab3d5678` | Retained message | READ/FIND/COPY inspect; SEND replies. Neither EDIT nor KILL changes its source. |
| `loop://reviewer/1` | Retained loop result | READ/FIND/COPY inspect; source is immutable. |
| `worker://reviewer/notes.md` | Named scratch entry | Read and write from any worker in the workspace. |
| `worker:///notes.md` | Shared commons entry | Read and write. |

The packet names your worker, its parent (`null` at a root), and the loop and turn you are producing under `## Worker`, below the log. Addresses are literal and keep
the same meaning when passed to another worker. All scratch belongs to the
workspace; its namespace does not require a namesake worker. Generated
references live under `worker:///_plurnk/`; reference
refreshes may replace those generated documents. EDIT creates or changes an
entry, never a worker. An unscoped EDIT creates the entry from its body.

````EDIT (worker://reviewer/scratch/greet.mjs) <!-- create the entry from the body -->
export const greet = (name) => `hello ${name}`;

console.log(greet("world"));
````

Control addresses contain only scheme and authority: no trailing slash,
userinfo, port, query, or fragment. Messages and loop outcomes have separate
addresses; neither is a scratch entry or an actor control.

An entry whose source has a readable projection (HTML, a notebook) carries it
beside the source as `#readable`, text/markdown, in its own line coordinates;
the default channel stays the source. Patterns match the channel they address:
`page.html` matches the markup, `page.html#readable` the Markdown. The
projection follows every source write and is never written itself.

## Turn sources

| Address | Read-only source in the named worker's history |
| --- | --- |
| `ops://<worker>/<loop>/<turn>` | The exact submitted program, including interstitial text. |
| `reasoning://<worker>/<loop>/<turn>` | Original provider reasoning when exposed, or a harness turn's authored rationale. |
| `note://<worker>/<loop>/<turn>/<item>` | The literal NOTE body, from the program or exposed reasoning; the receipt gives its address. |

The worker name is required. Any worker in the workspace can READ these sources;
SEND an address to share a note deliberately. `log:///` remains your own context.
READ brings the selected source into your log; KILL of that READ curates only
its log projection, never the original evidence. No later reasoning is added
automatically after initialization's example READ.

A READ can retain your current turn's reasoning: the source exists when your
OPs execute. The packet's `## Worker` block names the coordinate you are
producing. For example, as `worker://reviewer` on `"loop":1,"turn":3`:

````READ (reasoning://reviewer/1/3) <1,-1>
````

The ordinary READ receipt appears in subsequent packets. A turn that produced
no reasoning reads empty; a turn that has not happened returns a missing-source
result. READ never requests inference.

NOTE retains working memory without changing the loop state. Only NOTE also
executes from exposed reasoning; quoted examples and other reasoned operations
remain data. Notes are ordinary log items: KILL or trim their log projection
when no longer useful. Their read-only sources remain searchable and
READable, including after log curation or a FORK.

````FIND (note://reviewer/**) /parser/
````

````READ (note://reviewer/1/3/2) <1,-1>
````

## Delegation

Parents passively observe child mutations, messages, executor invocations, and
worker launches, including failed actions. Exploration and context
curation (NOTE, READ, FIND, BARE, WAIT, and log KILL) stay with the child, including
READs of executor output. These observations never wake the parent; replies and
child conclusions retain their ordinary delivery and wake behavior.

Open Messages names unanswered messages; an arrival receipt's `resource` links
to the same source. SEND to that address answers that message. A targetless SEND
answers your observed Open Messages; SEND to a worker control address gives it
new work instead. Curation of a message's log occurrences never deletes the
source or changes whether it was answered. Another worker may answer it;
the assigned worker and original sender receive that reply without a new request.

**WORK to delegate, FORK to branch.** WORK starts a fresh log with your task
prompt; FORK copies your history and named scratch into its new name, then
diverges. Embedded addresses are preserved verbatim. Both share the workspace.
Omit the address to allocate a short worker name, reported in the receipt;
explicit names cannot replace an existing worker, even after it finishes.
Names match `[A-Za-z0-9][A-Za-z0-9_-]{0,62}` and are case-sensitive.
A path outside the `worker://` scheme is the child's prompt resource, as for
BARE: `WORK (specs/feature.md)` reads the file whole as the task,
an inline body follows it after a blank line, and the child is auto-named.
Use SEND to give an existing worker a follow-up task.

SEND accepts `[{"attachments":["report.pdf","worker:///notes.md"]}]`.
It delivers send-time copies through ordinary resource links, not native media
injection; the recipient READs what it needs. Missing sources fail before
delivery. The same option works on a targetless reply.

A SEND takes no scope. To deliver a message later or on a cadence, to a worker
or to yourself, add a rule with the `schedule` family; it arrives as an
ordinary message from `schedule://<alias>`.

## BARE inference

BARE makes one isolated call to the child model, not a persistent worker.
It receives no parent history or tools. Give it a prompt resource, an inline
prompt, or both; resource text precedes an inline body with a blank line between.

````BARE (worker://reviewer/question.md)
````
````BARE
What is the capital of Germany?
````

The resource supplies its complete current READ text, not a preview. Neither
prompt form is truncated to fit; provider capacity still applies. A failed
source read returns its error without making an inference call.
Consecutive BARE calls run concurrently and settle before the turn continues.
Their answers are ordinary BARE receipts, visible in the next packet.

## Lifecycle

**Continue or wait.** Ordinary operations keep the loop working while children
run; WAIT joins their activity:

````WORK (worker://capital-checker)
Find the capital of France from a primary source
````

````WAIT
Await capital-checker's answer.
````

WAIT ignores target, scope, and metadata decorations. It continues the same loop: with live
work, a child or an open stream, the loop parks and wakes when that work
settles, when a message arrives, or on an open stream's observation cadence;
without live work it continues at once. To wake later with nothing in flight,
add a rule with the `schedule` family targeting yourself.

A wake ends that wait. Submit WAIT to wait again. Waking
retains the loop's messages, turn allowance, and remaining execution time;
parked time does not consume execution time. Conclude by observing the work's
results and answering every Open Message with SEND. A later observation turn
can conclude without repeating a response already delivered.

Each child task's conclusion wakes its waiting parent and arrives as an
`_plurnk` READ of `loop://capital-checker/1`. This is the execution outcome,
not another message. Replies remain separate; failure retains its status and Problem.
READ that address with a scope to inspect more of the exact result, even after
the child starts another task. Bare `READ (worker://capital-checker)` collects
the current result instead, naming its exact source in `resource`. While the child is running it returns
`425`; ordinary operations continue and WAIT explicitly joins.
A result does not imply that every task in that worker has finished.

`KILL (worker://<name>)` cancels that worker and its descendants, including
queued work and unread messages. History remains readable; a later SEND can start new work.
