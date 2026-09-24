# COPY and MOVE

The first path is the source; the second is the destination. Each optional scope
follows its own path. Neither operation takes a body.

| Operand | No scope | With scope |
| --- | --- | --- |
| Source | Whole selected channel | Selected text, without receipt line numbers or hashes |
| Destination | Create; identical content is a no-op, different existing content is a conflict | Replace the selected region; `<0>` prepends, `<-1>` appends, `<1,-1>` replaces all |

Copy source lines 2–3 into a new entry:

```COPY (worker:///src.md) <2,3> (worker:///slice.md)
```

Append source line 1 to that entry:

```COPY (worker:///src.md) <1> (worker:///slice.md) <-1>
```

Move the whole resulting channel to a new address:

```MOVE (worker:///slice.md) (worker:///archive.md)
```

COPY leaves its source unchanged. MOVE removes the selected source region or
channel after the destination succeeds; a failed destination leaves it intact.
Paths can address files, workspace entries, or readable streams. Stream content
can be copied; MOVE cannot remove a stream's output. A log source contributes
only its untrimmed content, and MOVE curates that source as KILL would.
Transfers preserve content rather than converting incompatible mimetypes.
