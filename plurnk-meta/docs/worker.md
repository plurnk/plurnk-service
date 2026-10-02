# `worker://` — workers and their entries

## Summary

Coordinate workers (WORK, FORK), request isolated BARE inference, and manage workspace entries.

Workers inhabit one workspace. The authority selects a worker; a path selects
an entry rather than controlling that worker.

| Address | Meaning | Model access |
| --- | --- | --- |
| `worker://exampleWorkerName` | Named worker | WORK/FORK create; SEND messages; READ collects; KILL terminates. |
| `message://exampleWorkerName/ab3d5678` | Retained message | READ/FIND/COPY inspect; SEND replies. Neither EDIT nor KILL changes its source. |
| `ops://exampleWorkerName/1` | What that loop said, or how it ended | READ/FIND/COPY inspect; source is immutable. |
| `worker://exampleWorkerName/example.md` | Named scratch entry | Read and write from any worker in the workspace. |
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

A READ of an image, PDF or audio source retains its bytes: on a route whose
model takes that media, every later packet carries them as a native part
captioned with the READ's log coordinate, until you KILL that READ row. The
service never re-sends media; a captioned part is your own earlier READ, not a
new arrival.

## Delegation

[Delegation and messages](worker:///_plurnk/plurnk/delegation.md) covers worker
creation, child observations, waiting, completion, and reply routing.

## BARE inference

BARE makes one isolated call to the model, not a persistent worker. Nothing
reaches it but the fence body: no log, no files, no web, no tools, no memory of
this loop. It answers from the body and the model's own knowledge alone, so it
cannot look anything up, and what it does not know it will guess. Use it to
isolate a sub-problem whose complete inputs fit in the body — a long text to
judge, a tangle to reason through without the log in view — never to search,
recall, or fetch.

```BARE
A self-contained prompt, with everything it needs pasted in.
```

The prompt is not truncated to fit; provider capacity still applies.
Consecutive BARE calls run concurrently and settle before the turn continues.
Their answers are ordinary BARE receipts, visible in the next packet.

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
`READ (reasoning://exampleWorkerName/1/3) <1,-1>` from `worker://exampleWorkerName` on loop 1,
turn 3 retains it; a turn that produced no reasoning reads empty, and a turn
that has not happened returns a missing-source result. READ never requests
inference. Notes are ordinary log items whose read-only sources stay searchable
(`FIND (note://exampleWorkerName/**) /parser/`) and READable after curation or a FORK.
