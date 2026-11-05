# Delegation and messages

## Summary

WORK, FORK, SEND, WAIT, and KILL coordinate sessions and their obligations.

## Delegation

WORK starts a fresh log with the task prompt; FORK copies your
history and named scratch into the new name, then diverges. Embedded addresses
are preserved verbatim. Both share the workspace. An omitted address allocates
a short session name, reported in the receipt; an explicit name cannot replace
an existing session, even after it finishes. Names match
`[A-Za-z0-9][A-Za-z0-9_-]{0,62}` and are case-sensitive. SEND to an existing
session gives it a follow-up task.

await plurnk.work({ target: "session://child", prompt: "The child's complete task goes here." }); // fresh log

await plurnk.fork({ target: "session://exampleSessionName", prompt: "The child's task, continuing from what you already know." }); // a child that begins with your history

await plurnk.send({ target: "session://child", text: "The follow-up task or additional information goes here." }); // follow-up to the existing session

Write `session://child/AGENTS.md` (with `plurnk.edit` or `await plurnk.copy({ from: "persona://examplePersona/PERSONA.md", to: "session://child/AGENTS.md" });`) before WORK to give a
fresh child session role instructions that its first turn reads automatically;
FORK copies `session://<parent>/AGENTS.md` into `session://<child>/AGENTS.md`
with the rest of your named scratch, and updating `session://<name>/AGENTS.md`
later causes that session's next turn to read the updated instructions.

Parents observe a direct child's mutations, messages, executor invocations, and
session launches, including failed actions, as rows in their own log.
Exploration and context curation (NOTE, TODO, READ, FIND, BARE, WAIT, and log KILL)
stay with the child, including READs of executor output. These observations
never wake the parent; replies and child conclusions retain their ordinary
delivery and wake behavior.

## Lifecycle

Ordinary operations keep the loop working while children run; WAIT joins their
activity. With live work (a child or an open stream) the loop parks and wakes
when that work settles, when a message arrives, or when the wait duration expires;
without live work it does not park. `await plurnk.wait({ seconds: 600 });` waits at most ten minutes;
`await plurnk.wait({});` uses the configured default. Expiry resumes inspection without
cancelling work. Zero continues immediately. Invalid durations are ignored with
a warning. Several WAITs are one park with the earliest bound. An optional
`target` is a label, not a selected wake source.

await plurnk.wait({});

A wake ends the suspension, not its held work; a further WAIT waits again.
Waking retains the loop's messages, turn allowance, and remaining execution
time; parked time does not consume execution time. Once all Open Messages have
completion replies, the loop settles after results are observed and held work
finishes. Replies are delivered immediately. NOTE, TODO, and successful curation do
not require another observation turn; other results may warrant more work or a
corrected reply. No additional operation is needed just to conclude.

Each child task's conclusion wakes its waiting parent and arrives once, as an
`_plurnk` READ of `ops://exampleSessionName/1` carrying what the child said: the
execution outcome, not another message, and not delivered again as a reply. A
failure retains its status and Problem. READ that address with a scope to
inspect more of the exact result, even after the child starts another task.
Bare `await plurnk.read({ path: "session://exampleSessionName" });` collects the current result instead, naming its
exact source in `resource`; while the child is running it returns `425`. A
result does not imply that every task in that session has finished.

`await plurnk.kill({ path: "session://<name>" });` cancels that session and its descendants, including
queued work and unread messages. History remains readable; a later SEND can
start new work.

await plurnk.kill({ path: "session://child" }); // cancel this session's activity

## Messages

`Open Work`'s `messages` list names unresolved requests; an arrival receipt's `resource` links
to the same source. DONE, FAIL, or SEND to that address replies to that message. Without a `target`,
DONE, FAIL, and SEND select the oldest Open Message; SEND leaves it open, while DONE and FAIL advance
to the next. With none open, SEND names a recipient explicitly, including for corrections.
DONE marks a completed request; FAIL marks a cancelled
request, without cancelling its session or running work. A SEND is progress,
leaving the request open. An empty DONE or FAIL still resolves
its message while retaining earlier speech. SEND to a session
control address gives it new work instead. Curation of a message's log
occurrences never deletes the source or changes whether it was answered.
Another session may answer it; the assigned session and original sender receive
that reply without a new request.

await plurnk.done({ target: "message://exampleSessionName/ab3d5678", text: "The completed answer to this request goes here." });

SEND, DONE, and FAIL accept `metadata: [{ attachments: ["report.pdf", "workspace:///example.md"] }]`:
send-time copies delivered through ordinary resource links, not native media
parts. Each is materialized as `message://<recipient>/<id>/<index>-<basename>`.
