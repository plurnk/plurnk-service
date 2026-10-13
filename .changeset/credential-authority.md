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
cancels no loop. The posture is the shared `PLURNK_AUTH` (default `1`),
never inferred from what else is set; `0` admits every request anonymously
and serves no authorization server. `PLURNK_AGUI_TOKEN` is gone: the
operator's client secret is the shared `PLURNK_SECRET`, and when it is unset
the daemon mints one at every boot into the file `secret` beside its
database (0600), where the operator's own tools read it, so a fresh install
authenticates with nothing configured. `PLURNK_USER` and `PLURNK_PASS` sign
the operator in from a browser. The secret itself is never a bearer: a
client exchanges it for an access token. Operators who set
`PLURNK_AGUI_TOKEN` or `PLURNK_AGUI_SECRET` rename the line to
`PLURNK_SECRET`, or remove it and let the daemon mint.
