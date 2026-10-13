---
"@plurnk/plurnk-agui": major
"@plurnk/plurnk-service": minor
"@plurnk/plurnk-contracts": minor
---

The daemon owns one credential authority ({§credential-authority}) and AG-UI
is its OAuth 2.1 authorization server ({§agui-oauth}): discovery (RFC 8414,
RFC 9728), the operator's sign-in with authorization code and PKCE, client
credentials for the operator's own tools and for declared clients, refresh
tokens that rotate, revocation (RFC 7009) and public-client registration
(RFC 7591), all on the daemon's listener. `/agui` admits access tokens with
RFC 6750 challenges and names the credential's subject as the run's
principal; a revoked credential ends the streams admitted under it and
cancels no loop. `PLURNK_AGUI_TOKEN` is `PLURNK_AGUI_SECRET`, the operator's
client secret, which a fresh install mints; `PLURNK_AGUI_USER` and
`PLURNK_AGUI_PASSWORD` sign the operator in from a browser. The secret itself
is never a bearer: a client exchanges it for an access token.
