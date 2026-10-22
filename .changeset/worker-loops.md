---
"@plurnk/plurnk-agui": minor
---

`worker.loops` lists a worker's loops in sequence order: each loop's number,
lifecycle, the sender of its opening message, that message's first line (at most
`PLURNK_AGUI_EXCERPT_CHARS` characters) and whether it holds more
({§agui-worker-loops}). The history page takes `loop=<sequence>` in place of
`before` and answers that loop whole ({§agui-loop-page}); a malformed loop is
400 `history-loop-invalid`, an absent one 404 `history-loop-not-found`.
