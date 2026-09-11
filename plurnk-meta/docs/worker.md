# `worker://` — workers and their entries

## Summary

Coordinate workers, request isolated BARE inference, and manage workspace entries.

Workers inhabit one workspace. The authority selects a worker; a path selects
an entry rather than controlling that worker.

| Address | Meaning | Model access |
| --- | --- | --- |
| `worker://reviewer` | Named worker | WORK/FORK create; SEND messages; READ collects; KILL terminates. |
| `worker://reviewer/notes.md` | Named scratch entry | Read and write from any worker in the workspace. |
| `worker:///notes.md` | Shared commons entry | Read and write. |

The packet names your worker, its parent (`null` at a root), and today's date and time zone under `## Worker`. Addresses are literal and keep
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
userinfo, port, query, fragment, or `[metadata]` modifier.

## Turn sources

| Address | Read-only source in your worker's history |
| --- | --- |
| `ops:///<loop>/<turn>` | The exact submitted program, including interstitial text. |
| `reasoning:///<loop>/<turn>` | Original provider reasoning when exposed, or a harness turn's authored rationale. |

READ brings the selected source into your log; KILL of that READ curates only
its log projection, never the original evidence. No later reasoning is added
automatically after initialization's example READ.

A READ can retain your current turn's reasoning: the source exists when your
OPs execute. For example, on loop 1, turn 3:

````READ (reasoning:///1/3) <1,-1>
````

The ordinary READ receipt appears in subsequent packets. Missing or future
sources return a missing-source result; READ never requests inference.

## Delegation

**WORK to delegate, FORK to branch.** WORK starts a fresh log with your task
prompt; FORK copies your history and named scratch into its new name, then
diverges. Embedded addresses are preserved verbatim. Both share the workspace.
Omit the address to allocate a short worker name, reported in the receipt;
explicit names cannot replace an existing worker, even after it finishes.
Use SEND to give an existing worker a follow-up task.

Directed SEND accepts `<delay,interval>` in whole minutes to schedule its body
as a new task, rather than interrupting an unfinished task:

````SEND (worker://reviewer) <0,60>
Check for new messages and report relevant findings.
````

`<60>` runs once after an hour; `<0,60>` starts immediately and repeats hourly.
Delay is nonnegative; an interval is positive. Occurrences never overlap; missed
ticks coalesce without a backlog. Each occurrence uses the original instruction
and policy with fresh task limits. Success permits the next occurrence; an all-failed inventory or
an engine failure ends the recurrence. KILL cancels current and future tasks.
Queued future tasks remain live worker obligations, visible with their due times.

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

**Continue or wait.** TASK declares the current inventory. An `in_progress`
item keeps the loop working while children run; `waiting` joins their activity:

````WORK (worker://capital-checker)
Find the capital of France from a primary source
````

````TASK
[{"content":"Await capital-checker's answer.","status":"waiting"}]
````

TASK with waiting intent accepts `<timeout,poll>` in whole minutes. It continues the same loop;
neither a deadline nor a poll repeats a message or command.

| Scope | Wake condition |
| --- | --- |
| Omitted / `<-1>` | Existing work completes or a message arrives; inherit open streams' polling. |
| `<60>` | Also wake after at most 60 minutes, even without other work. |
| `<-1,60>` | Also wake after 60 minutes to observe; no wait deadline. |
| `<60,0>` | Deadline or an event; no periodic stream observation. |

A wake ends that wait. Submit another waiting inventory to wait again. Waking
retains the loop's prompts, turn allowance, and remaining execution time;
parked time does not consume execution time. An untimed wait without live work
continues. A terminal inventory with at least one completed item claims success;
a nonempty all-failed inventory concludes unsuccessfully.

Each child task's conclusion reaches its parent automatically as a log `SEND` from
`worker://capital-checker`, waking a waiting parent. Success includes the body;
failure preserves its status and Problem. ````` ````READ (worker://capital-checker) `````
collects the same result explicitly. While the child is running it returns
`425`; the inventory still chooses whether to continue or wait.
A result does not imply that every task in that worker has finished.

````` ````KILL (worker://<name>) ````` cancels that worker and its descendants, including
queued work and unread messages. History remains readable; a later SEND can start new work.
