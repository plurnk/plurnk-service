# `copy` and `move`

## Summary

Copy or move files, workspace entries, streams, or scoped text regions.

`from` is the source; `to` is the destination. Each endpoint accepts a path string or `{ path, range?, pattern?, headers? }`.

| Operand | No `range` | With `range` |
| --- | --- | --- |
| `from` | Whole selected channel | Selected text, without receipt line numbers or hashes |
| `to` | Create; identical content is a no-op, different existing content is a conflict | Replace the selected region; `"0"` prepends, `"-1"` appends, `"1,-1"` replaces all |

await plurnk.copy({ from: { path: "workspace:///src.md", range: "2,3" }, to: "workspace:///slice.md" });

await plurnk.copy({ from: { path: "workspace:///src.md", range: "1" }, to: { path: "workspace:///slice.md", range: "-1" } });

await plurnk.move({ from: "workspace:///slice.md", to: "workspace:///archive.md" });

- `plurnk.copy` leaves `from` unchanged; `plurnk.move` removes the selected source region or channel after `to` succeeds (if source removal conflicts after `to` is written, the receipt reports the completed destination write).
- Streams can be copied, never moved; moving from a `log:///` source curates that log item as `plurnk.kill` would.
- Transfers preserve content verbatim without converting incompatible mimetypes.
