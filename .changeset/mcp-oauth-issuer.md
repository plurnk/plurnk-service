---
"@plurnk/plurnk-contracts": minor
"@plurnk/plurnk-mcp": minor
---

An interactive `McpOAuth` definition may name the `issuer` its sign-in binds
to, where discovery starts, and `authorizationParams` added to the
authorization request, such as `access_type=offline` ({§mcp-oauth},
{§oauth-issuer}). `oauth.begin` for an alias awaiting a sign-in after a refused
request starts the authorization on a connection its server never challenges
({§oauth-begin-unchallenged}).
