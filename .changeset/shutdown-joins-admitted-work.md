---
"@plurnk/plurnk-agui": patch
---

Shutdown joins what the module admitted: `close` returns once every admitted
request and the work its Runs started have settled, so none reaches core after the
module closes, and a request still preparing at shutdown answers `service-stopping`
instead of failing on a closed database ({§agui-shutdown}).
