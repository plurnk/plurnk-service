---
"@plurnk/plurnk-agui": minor
"@plurnk/plurnk-service": minor
---

Hardening lives in front of the daemon, not in it. The service package ships
`plurnk.nginx.conf` beside `plurnk.service`: TLS, security headers, sign-in
throttling by real client address and an optional allow-list
({§nginx-example}). The authorization server no longer counts failed sign-ins
or client secrets per address: behind a proxy every browser shared one
address, so five wrong passwords locked everyone out.
`PLURNK_AGUI_LOGIN_ATTEMPTS` and `PLURNK_AGUI_LOGIN_WINDOW_SEC` are gone;
delete them from an operator file.
