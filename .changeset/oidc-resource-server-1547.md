---
"@plurnk/plurnk-auth": major
"@plurnk/plurnk-contracts": major
"@plurnk/plurnk-acp": major
"@plurnk/plurnk-mcp": major
"@plurnk/plurnk-service": major
"@plurnk/plurnk-mimetypes": patch
"@plurnk/plurnk-mimetypes-application-xml": patch
"@plurnk/plurnk-mimetypes-audio": patch
"@plurnk/plurnk-mimetypes-image": patch
"@plurnk/plurnk-mimetypes-text-html": patch
"@plurnk/plurnk-parser": patch
---

Default the `:1066` loopback listener to zero-password access with browser
same-origin CSRF and loopback DNS-rebinding defenses (`admitBrowserOrigin`),
retire the in-daemon OAuth 2.1 server, password hashing, and host
`secret`/`credentials` files, and repurpose `@plurnk/plurnk-auth` into an
optional `jose`-backed external OIDC / OAuth 2.1 resource server
(`PLURNK_AUTH_ISSUER`, `PLURNK_AUTH_CLIENT_ID`, `PLURNK_AUTH_AUDIENCE`,
`PLURNK_AUTH_CALLBACK`, `PLURNK_AUTH_SCOPES`, `PLURNK_AUTH_USERS`) serving
RFC 9728 `/.well-known/oauth-protected-resource` (#1547).
