# @plurnk/plurnk-auth

Optional OIDC / OAuth 2.1 resource-server module for the PLURNK daemon.

## Overview

By default (`PLURNK_AUTH_ISSUER` empty), `@plurnk/plurnk-auth` claims no HTTP mounts and publishes no
credential face, leaving a loopback daemon immediately accessible without passwords or secret files
(or ready to sit behind an edge authentication proxy such as Caddy, `oauth2-proxy`, Cloudflare Access,
Authelia, or Tailscale Serve).

When `PLURNK_AUTH_ISSUER` names an external OIDC / OAuth 2.1 identity provider, the module publishes
a `jose`-backed JWT verifier on the daemon's `CredentialAuthority` ({§credential-authority}) and mounts
`GET /.well-known/oauth-protected-resource` (RFC 9728) on the shared listener ({§auth-oauth}) so
browser (`@plurnk/plurnk-web`) and terminal (`plurnk`) clients discover the external provider and
authenticate with standard OIDC PKCE. Set `PLURNK_AUTH_DELEGATES` to a comma-separated list of JWT
`sub` identifiers to authorize authenticated bridges to attribute exterior speakers (`_meta.plurnk.actor`).

See [`SPEC.md`](./SPEC.md) for the complete specification.
