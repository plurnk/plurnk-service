---
"@plurnk/plurnk-a2a": major
"@plurnk/plurnk-contracts": minor
---

The hosted A2A exposure authenticates exactly as the daemon does
({§a2a-hosted-credentials}): its card declares OAuth 2.0 client credentials at
the daemon's own token endpoint with the scope `a2a`, the endpoint admits the
authority's access tokens, and a remote agent is a declared client
(`PLURNK_AGUI_CLIENT_<id>`). `PLURNK_A2A_TOKEN` is gone. An outbound definition's
`authorization` may be OAuth 2.0 client credentials (`clientId`, a symbolic
`clientSecret`, optional `tokenUrl` and `scope`), obtained from the agent's
declared flow and renewed once on 401 ({§a2a-outbound-credentials}).
