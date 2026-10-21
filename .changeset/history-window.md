---
"@plurnk/plurnk-agui": major
---

A snapshot is a window: the bound worker's newest `PLURNK_AGUI_HISTORY_LOOPS`
loops (2), cut between whole turns, within `PLURNK_AGUI_HISTORY_PAGE_CHARS`
(2,000,000) of the serialized event, its `metadata.plurnk.history.older`
linking the page before ({§agui-history-window}). `GET` at that link answers
`{ final, messages, older }`, one loop per page under the same ceiling
({§agui-history-page}). A Run sends a fresh window at a turn boundary once
its client holds more than the ceiling ({§agui-history-advance}). Every live delta
stays within the ceiling, a call's arguments and reasoning as well as words; a
part that alone would pass it carries the words its senders wrote by reference,
an accepted message's at the address that minted it, and model output past it
travels whole in a page of its own ({§agui-words-by-reference}).
