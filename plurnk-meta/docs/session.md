# `session://` — sessions and their entries

## Summary

Coordinate sessions (`work`, `fork`), request isolated `bare` inference, and manage workspace entries.

| Address | Meaning | Model access |
| --- | --- | --- |
| `session://exampleSessionName` | Named session (authority-only: no path, query, or fragment) | `work`/`fork` create; `send` messages; `read` collects; `kill` terminates. |
| `message://exampleSessionName/00` | Retained message | `read`/`find`/`copy` inspect; `send`/`done`/`fail` reply. Source is immutable. |
| `ops://exampleSessionName/1` | Loop conclusion (`<session>/<loop>`) | `read`/`find`/`copy` inspect; source is immutable. |
| `session://exampleSessionName/example.md` | Named session scratch entry | Read and write from any session in the workspace (`kill` deletes the entry, not the session). |
| `session://exampleSessionName/AGENTS.md` | Session instruction sheet | Read automatically by `exampleSessionName` when created or updated. |
| `persona://examplePersona/PERSONA.md` | Discovered persona role | `read`/`find`/`copy` inspect; `copy` to `session://<name>/AGENTS.md` binds role. |
| `workspace:///example.md` | Shared workspace entry | Read and write from any session in the workspace. |

- **Channels & projections**: entries with a readable projection (HTML, notebooks) expose `#readable` (`text/markdown`) alongside the default source channel (`body`); `#readable` updates automatically on source writes.
- **Media retention**: reading an image, PDF, or audio resource attaches the native media (captioned with its `log:///` coordinate) on supporting model routes until you `plurnk.kill` that `read` log row.
- **Delegation & messaging**: see [Delegation and messages](skill://plurnk/delegation.md).

## Bare inference

`plurnk.bare({ text })` runs one stateless, toolless model call with no log, files, or tools—only `text`:

await plurnk.bare({ text: "A self-contained prompt, with everything it needs pasted in." })

Consecutive `bare` calls run concurrently and return their answers as ordinary `bare` receipts in the next packet.

## Turn sources

| Address | Read-only source in the named session's history |
| --- | --- |
| `ops://<session>/<loop>/<turn>` | Exact submitted program, including interstitial text. |
| `reasoning://<session>/<loop>/<turn>` | Provider reasoning (when exposed) or harness turn rationale. |
| `note://<session>/<loop>/<turn>/<item>` | Literal `note` body (searchable via `plurnk.find` and readable after log curation or `fork`). |

`plurnk.kill` on a `log:///` `read` row curates only the log projection, never the underlying turn source.
