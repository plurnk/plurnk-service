---
"@plurnk/plurnk-contracts": major
"@plurnk/plurnk-providers": major
"@plurnk/plurnk-models": major
"@plurnk/plurnk-spec-check": minor
"@plurnk/plurnk-acp": minor
"@plurnk/plurnk-service": major
"@plurnk/plurnk-mcp": patch
"@plurnk/plurnk-mimetypes": patch
"@plurnk/plurnk-mimetypes-application-ipynb": patch
"@plurnk/plurnk-mimetypes-application-json": patch
"@plurnk/plurnk-mimetypes-application-jsonl": patch
"@plurnk/plurnk-mimetypes-application-pdf": patch
"@plurnk/plurnk-mimetypes-application-xml": patch
"@plurnk/plurnk-mimetypes-audio": patch
"@plurnk/plurnk-mimetypes-image": patch
"@plurnk/plurnk-mimetypes-text-csv": patch
"@plurnk/plurnk-mimetypes-text-diff": patch
"@plurnk/plurnk-mimetypes-text-dotenv": patch
"@plurnk/plurnk-mimetypes-text-html": patch
"@plurnk/plurnk-mimetypes-text-ini": patch
"@plurnk/plurnk-mimetypes-text-markdown": patch
"@plurnk/plurnk-mimetypes-text-plain": patch
"@plurnk/plurnk-schemes": patch
"@plurnk/plurnk-schemes-http": patch
"@plurnk/plurnk-execs": patch
"@plurnk/plurnk-execs-common": patch
"@plurnk/plurnk-parser": patch
"@plurnk/plurnk-digest": patch
"@plurnk/plurnk-meta": patch
"@plurnk/plurnk-aliases": patch
"@plurnk/plurnk-agent-plugins": patch
"@plurnk/plurnk-agent-skills": patch
"@plurnk/plurnk-skills": patch
"@plurnk/plurnk-modules": patch
"@plurnk/plurnk-hooks": patch
"@plurnk/plurnk-otel": patch
"@plurnk/plurnk-schedule": patch
"@plurnk/plurnk-auth": patch
---

Delegate model catalog discovery and provider streaming directly to
`@mariozechner/pi-ai` (`#1286`, `#1305`), restrict `service.update` to model
catalog refresh (`#1285`), allow trusted third-party
`@plurnk/plurnk-mimetypes-*` packages to override built-in floor handlers
(`#1306`), keep ACP SSE streams alive with `heartbeatMs` and restore
disconnect/gate-transfer integration coverage (`#1307`, `#1308`), unify
`ApplicationPort` and domain modules (`#1287`–`#1304`, `#1312`), and enforce
heading-only `§tag` declarations and dual witnesses in `plurnk-spec-check`
(`#1283`, `#1309`, `#1311`).
