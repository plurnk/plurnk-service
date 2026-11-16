# `session://` — sessions, delegation, and messages

## Summary

Coordinate sessions (`work`, `fork`, `send`, `wait`, `kill`, `done`, `fail`), request isolated `bare` inference, and manage session/workspace entries.

| Address | Meaning | Model access |
| --- | --- | --- |
| `session://exampleSessionName` | Named session (authority-only: no path, query, or fragment) | `work`/`fork` create; `send` messages; `read` collects; `kill` terminates. |
| `message://exampleSessionName/00` | Retained message | `read`/`find`/`copy` inspect; `send`/`done`/`fail` reply. Source is immutable. |
| `ops://exampleSessionName/1` | Loop conclusion (`<session>/<loop>`) | `read`/`find`/`copy` inspect; source is immutable. |
| `session://exampleSessionName/example.md` | In-database session scratch entry (not on disk) | Read and write from any session in the workspace (`kill` deletes the entry, not the session); project files on disk use plain relative paths. |
| `session://exampleSessionName/AGENTS.md` | Session instruction sheet | Read automatically by `exampleSessionName` when created or updated. |
| `persona://examplePersona/PERSONA.md` | Discovered persona role | `read`/`find`/`copy` inspect; `copy` to `session://<name>/AGENTS.md` binds role. |
| `workspace:///example.md` | Shared in-database workspace entry (not on disk) | Read and write from any session in the workspace; project files on disk use plain relative paths. |

- **Channels & projections**: entries with a readable projection (HTML, notebooks) expose `#readable` (`text/markdown`) alongside the default source channel (`body`); `#readable` updates automatically on source writes.
- **Media retention**: reading an image, PDF, or audio resource attaches the native media (captioned with its `log:///` coordinate) on supporting model routes until you `kill` that `read` log row.

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

`## Open Work` lists unresolved `messages` (`message://<session>/<id>`). Iff there is only one Open Message, `target` is optional:

| Tool & arguments | Effect on Open Message |
| --- | --- |
| `done` `{ target?, text, attachments? }` | Complete and resolve the Open Message. |
| `fail` `{ target?, text, attachments? }` | Fail and resolve the Open Message without cancelling the session. |
| `send` `{ target?, text, attachments? }` | Send a progress update while leaving the Open Message unresolved (or send a new task when `target` is `session://<name>`). |

`attachments` (`["report.pdf", "workspace:///example.md"]`) are materialized for the recipient as `message://<recipient>/<id>/<index>-<basename>`.

## Bare inference

`bare` (`{"text": "A self-contained prompt, with everything it needs pasted in."}`) runs one stateless, toolless model call with no log, files, or tools—only `text`. Consecutive `bare` calls run concurrently and return their answers as ordinary `bare` receipts in the next packet.

## Turn sources

| Address | Read-only source in the named session's history |
| --- | --- |
| `ops://<session>/<loop>/<turn>` | Exact submitted turn operations. |
| `reasoning://<session>/<loop>/<turn>` | Provider reasoning (when exposed) or harness turn rationale. |
| `note://<session>/<loop>/<turn>/<item>` | Literal `note` body (searchable via `find` and readable after log curation or `fork`). |

`kill` on a `log:///` `read` row curates only the log projection, never the underlying turn source.
