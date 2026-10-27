# COPY and MOVE

The first path is the source; the second is the destination. Each optional scope
follows its own path. Neither operation takes a body.

| Operand | No scope | With scope |
| --- | --- | --- |
| Source | Whole selected channel | Selected text, without receipt line numbers or hashes |
| Destination | Create; identical content is a no-op, different existing content is a conflict | Replace the selected region; `<0>` prepends, `<-1>` appends, `<1,-1>` replaces all |

Copy source lines 2–3 into a new entry:

```COPY (workspace:///src.md) <2,3> (workspace:///slice.md)
```

Append source line 1 to that entry:

```COPY (workspace:///src.md) <1> (workspace:///slice.md) <-1>
```

Move the whole resulting channel to a new address:

```MOVE (workspace:///slice.md) (workspace:///archive.md)
```

COPY leaves its source unchanged. MOVE removes the selected source region or
channel after the destination succeeds; a failed destination leaves it intact.
A changed file source is preserved. If removal fails after the destination was
written, the result reports that destination; MOVE is not a transaction across
both resources ({§file-snapshot-revision}, {§move-cross-scheme-move}).
Paths can address files, workspace entries, or readable streams. Stream content
can be copied; MOVE cannot remove a stream's output. A log source contributes
only its untrimmed content, and MOVE curates that source as KILL would.
Transfers preserve content rather than converting incompatible mimetypes.
