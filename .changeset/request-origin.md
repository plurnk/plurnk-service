---
"@plurnk/plurnk-contracts": minor
"@plurnk/plurnk-agui": minor
"@plurnk/plurnk-a2a": minor
---

A daemon bound to every interface (`PLURNK_HOST=0.0.0.0`) is reachable at
any of its addresses with nothing else set ({§http-request-origin}). With
`PLURNK_AGUI_ISSUER` empty, the issuer is the origin each request reached:
the authorization documents, sign-in redirects and the A2A card's token and
interface addresses follow it. No request is refused for the name it uses;
the 421 for a Host other than loopback or the issuer's is gone. Set the
issuer only when a front the daemon cannot see, such as a TLS proxy, serves
another origin. The credential face answers `issuer(req)`, and contracts
exports `requestOrigin`.
