# `session://` — sessions and their entries

## Summary

Coordinate sessions (`work`, `fork`), request isolated `bare` inference, and manage workspace entries.

Sessions inhabit one workspace. The authority selects a session; a path selects
an entry rather than controlling that session.

| Address | Meaning | Model access |
| --- | --- | --- |
| `session://exampleSessionName` | Named session | `work`/`fork` create; `send` messages; `read` collects; `kill` terminates. |
| `message://exampleSessionName/ab3d5678` | Retained message | `read`/`find`/`copy` inspect; `send` replies. Neither `edit` nor `kill` changes its source. |
| `ops://exampleSessionName/1` | What that loop said, or how it ended | `read`/`find`/`copy` inspect; source is immutable. |
| `session://exampleSessionName/example.md` | Named scratch entry | Read and write from any session in the workspace. |
| `persona://examplePersona/PERSONA.md` | Discovered persona role | `read`/`find`/`copy` inspect; `copy` to `session://<name>/AGENTS.md` binds role. |
| `workspace:///example.md` | Shared commons entry | Read and write. |

The packet's `## Session` block, below the log, names your session, its parent
(`null` at a root), the loop and turn you are producing, and its `owner`
(`address` and `interactive`). Addresses are
literal and keep the same meaning when passed to another session. Scratch
belongs to the workspace; a namespace does not require a namesake session, and if
`session://exampleSessionName/AGENTS.md` exists when that session starts (or is written later), its next turn reads the unread revision.
Generated tool references live under `mcp:///`, and reference refreshes
may replace them. `plurnk.edit` creates or changes an entry, never a session; `plurnk.kill` with
an entry path deletes that entry, not its session. A control address is scheme
and authority only: no trailing slash, userinfo, port, query, or fragment.
Messages and loop outcomes have their own addresses; neither is a scratch
entry or an actor control.

An entry whose source has a readable projection (HTML, a notebook) carries it
beside the source as `#readable`, text/markdown, in its own line coordinates;
the default channel stays the source, and a pattern matches the channel it
addresses. The projection follows every source write and is never written
itself.

A `plurnk.read` of an image, PDF or audio source retains its bytes: on a route whose
model takes that media, every later packet carries them as a native part
captioned with the `read` receipt's log coordinate, until you `plurnk.kill` that `read` row. The
service never re-sends media; a captioned part is your own earlier `read`, not a
new arrival.

## Delegation

[Delegation and messages](skill://plurnk/delegation.md) covers session
creation, child observations, waiting, completion, and reply routing.

## Bare inference

`plurnk.bare({ prompt })`: makes one isolated call to the model, not a persistent session. Nothing
reaches it but `prompt`: no log, no files, no web, no tools, no memory of
this loop. It answers from `prompt` and the model's own knowledge alone.

await plurnk.bare({ prompt: "A self-contained prompt, with everything it needs pasted in." });

The prompt is not truncated to fit; provider capacity still applies.
Consecutive `bare` calls run concurrently and settle before the turn continues.
Their answers are ordinary `bare` receipts, visible in the next packet.

## Turn sources

| Address | Read-only source in the named session's history |
| --- | --- |
| `ops://<session>/<loop>/<turn>` | The exact submitted program, including interstitial text. |
| `reasoning://<session>/<loop>/<turn>` | Original provider reasoning when exposed, or a harness turn's authored rationale. |
| `note://<session>/<loop>/<turn>/<item>` | The literal `note` body, from the program or exposed reasoning; the receipt gives its address. |

The session name is required. Any session in the workspace can `read` these
sources; `log:///` remains your own context. `plurnk.read` brings the selected source
into your log, and `plurnk.kill` of that `read` curates only its log projection, never the
original evidence. The current turn's reasoning exists when its operations execute, so
`await plurnk.read({ path: "reasoning://exampleSessionName/1/3", range: "1,-1" });` from `session://exampleSessionName` on loop 1,
turn 3 retains it; a turn that produced no reasoning reads empty, and a turn
that has not happened returns a missing-source result. `plurnk.read` never requests
inference. Notes are ordinary log items whose read-only sources stay searchable
(`await plurnk.find({ path: "note://exampleSessionName/**", pattern: "/parser/" });`) and readable after curation or a `fork`.
