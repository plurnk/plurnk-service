---
"@plurnk/plurnk-agui": major
---

A snapshot is a window: the bound worker's newest `PLURNK_AGUI_HISTORY_LOOPS`
loops (2), cut between whole turns, within `PLURNK_AGUI_HISTORY_PAGE_CHARS`
(2,000,000) of the serialized event, its `metadata.plurnk.history.older`
linking the page before ({§agui-history-window}). `GET` at that link answers
`{ final, messages, older }`, one loop per page under the same ceiling
({§agui-history-page}). A Run sends a fresh window at a turn boundary once
its client holds more than the ceiling ({§agui-history-advance}). Words past
the ceiling stream in bounded deltas and replay by reference at their row's
log address, which now serves an arrival's or a reply's words
({§agui-words-by-reference}).
