---
"@plurnk/plurnk-service": patch
---

`plurnk-service` refuses a Node.js below its `engines.node` floor with one
line naming both versions, exit 1, before any other module loads
({§service-runtime-floor}). `daemon/provider/not-configured` recovers with
"Select a model for this worker, or set `PLURNK_MODEL=<provider/model>` as
the service default; that provider's API key must be in the service's
environment." ({§problems-functionality}). The generated
`~/.config/plurnk/.env` cites no spec tag.
