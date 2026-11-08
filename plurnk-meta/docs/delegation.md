# Delegation and messages

## Summary

`work`, `fork`, `send`, `wait`, and `kill` coordinate sessions and their obligations.

## Delegation

`plurnk.work` starts a fresh log with the task prompt; `plurnk.fork` copies your history and named scratch into the new session, then diverges. `plurnk.send` to an existing session (`session://<name>`) delivers a follow-up task. Session names match `[A-Za-z0-9][A-Za-z0-9_-]{0,62}` (case-sensitive, authority-only `session://<name>` with no path or query; omit `target` on `work`/`fork` to auto-mint a name).

await plurnk.work({ target: "session://child", text: "The child's complete task goes here." }) // fresh log

await plurnk.fork({ target: "session://exampleSessionName", text: "The child's task, continuing from what you already know." }) // a child that begins with your history

await plurnk.send({ target: "session://child", text: "The follow-up task or additional information goes here." }) // follow-up to the existing session

- **Role instructions (`AGENTS.md`)**: write `session://child/AGENTS.md` (via `plurnk.edit` or `await plurnk.copy({ from: "persona://examplePersona/PERSONA.md", to: "session://child/AGENTS.md" })`) before `work` (or between turns) so the child's next turn reads it automatically.
- **Parent visibility**: parents observe a direct child's mutations, messages, executor calls, and spawns in their own log without waking; child exploration and curation (`note`, `todo`, `read`, `find`, `bare`, `wait`, log `kill`) stay local to the child.

## Lifecycle

| Operation | Behavior |
| --- | --- |
| `await plurnk.wait({})` | Park while live work (a running child or open stream) is active, waking when work settles, a message arrives, or `seconds` expires (expiry resumes inspection without cancelling work). |
| `_plurnk` `read` of `ops://child/1` | Delivered once when a child loop concludes, waking a waiting parent with the child's terminal reply or Problem (`plurnk.read` with `range` inspects further slices). |
| `await plurnk.read({ path: "session://child" })` | Collect the child's latest loop outcome (`425` while the child is still running). |
| `await plurnk.kill({ path: "session://child" })` | Cancel the child session and its descendants (history remains readable; a later `send` starts a new loop). |

await plurnk.wait({}) // waiting for child session

await plurnk.kill({ path: "session://child" }) // cancel this session's activity

`note`, `todo`, and successful curation do not require another observation turn before concluding.

## Messages

`## Open Work` lists unresolved `messages` (`message://<session>/<id>`):

| Operation | Effect on Open Message |
| --- | --- |
| `await plurnk.done({ target?, text, attachments? })` | Complete and resolve the target (or oldest open) message. |
| `await plurnk.fail({ target?, text, attachments? })` | Decline/cancel the target (or oldest open) message without cancelling the session. |
| `await plurnk.send({ target?, text, attachments? })` | Send a progress update while leaving the Open Message unresolved (or send a new task when `target` is `session://<name>`). |

await plurnk.done({ target: "message://exampleSessionName/ab3d5678", text: "The completed answer to this request goes here." })

`attachments` (`["report.pdf", "workspace:///example.md"]`) are materialized for the recipient as `message://<recipient>/<id>/<index>-<basename>`.
