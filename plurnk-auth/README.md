# @plurnk/plurnk-auth

OAuth 2.1 authorization server module for the PLURNK daemon.

## Overview

When `PLURNK_AUTH=1`, this module publishes the issuing face on the daemon's
`CredentialAuthority` ({§credential-authority}) and mounts the OAuth 2.1
authorization server on the daemon's listener ({§auth-oauth-endpoints}):

- `GET /.well-known/oauth-authorization-server` (RFC 8414)
- `GET /.well-known/oauth-protected-resource` (RFC 9728)
- `GET` / `POST /oauth/authorize` (authorization code with S256 PKCE)
- `POST /oauth/token` (`authorization_code`, `refresh_token`, `client_credentials`)
- `POST /oauth/revoke` (RFC 7009)
- `POST /oauth/register` (RFC 7591 public client registration)
- `GET` / `POST /oauth/session` (browser session inspection and sign-out)

When `PLURNK_AUTH=0`, the module claims no HTTP mounts and publishes no face.
Every protocol face (`@plurnk/plurnk-agui`, `@plurnk/plurnk-a2a`,
`@plurnk/plurnk-acp`) verifies bearer credentials against the shared
`CredentialAuthority` independently of how tokens are issued.

See [`SPEC.md`](./SPEC.md) for the complete specification.
