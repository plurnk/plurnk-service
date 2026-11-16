# Delegation and messages

## Summary

`work`, `fork`, `send`, `wait`, and `kill` coordinate sessions and their obligations.

## Delegation

`work` starts a fresh log with the task prompt; `fork` copies your history and named scratch into the new session, then diverges. `send` to an existing session (`session://<name>`) delivers a follow-up task. Session names match `[A-Za-z0-9][A-Za-z0-9_-]{0,62}` (case-sensitive, authority-only `session://<name>` with no path or query; omit `target` on `work`/`fork` to auto-mint a name).

- **Role instructions (`AGENTS.md`)**: write `session://child/AGENTS.md` (via `edit` or `copy` from `persona://examplePersona/PERSONA.md` to `session://child/AGENTS.md`) before `work` (or between turns) so the child's next turn reads it automatically.
- **Parent visibility**: parents observe a direct child's mutations, messages, executor calls, and spawns in their own log without waking; child exploration and curation (`note`, `read`, `find`, `bare`, `wait`, log `kill`) stay local to the child.

## Lifecycle

| Tool & arguments | Behavior |
| --- | --- |
| `wait` `{}` (or `{"seconds": 60}`) | Park at the end of the turn while live work (a running child or open stream) is active, waking when work settles, a message arrives, or `seconds` expires (expiry resumes inspection without cancelling work; emit follow-up `read`/`send` calls on the waking turn). |
| `_plurnk` `read` of `ops://child/1` | Delivered once when a child loop concludes, waking a waiting parent with the child's terminal reply or Problem (`read` with `range` inspects further slices). |
| `read` `{"path": "session://child"}` | Collect the child's latest loop outcome (`425` while the child is still running). |
| `kill` `{"path": "session://child"}` | Cancel the child session and its descendants (history remains readable; a later `send` starts a new loop). |

`note` and successful curation do not require another observation turn before concluding.

## Messages

`## Open Work` lists unresolved `messages` (`message://<session>/<id>`):

| Tool & arguments | Effect on Open Message |
| --- | --- |
| `done` `{ target?, text?, attachments? }` | Complete and resolve the target (or single open / latest single-sender published) message. |
| `fail` `{ target?, text?, attachments? }` | Decline/cancel the target (or single open / latest single-sender published) message without cancelling the session. |
| `send` `{ target?, text, attachments? }` | Send a progress update while leaving the Open Message unresolved (or send a new task when `target` is `session://<name>`). |

`attachments` (`["report.pdf", "workspace:///example.md"]`) are materialized for the recipient as `message://<recipient>/<id>/<index>-<basename>`.
