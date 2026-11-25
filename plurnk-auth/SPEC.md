# @plurnk/plurnk-auth — OIDC / OAuth 2.1 resource server

Optional OIDC / OAuth 2.1 resource-server module for the daemon's credential authority ({§credential-authority}), verifying presented JWT bearer tokens against an external identity provider's JWKS via `jose` and publishing RFC 9728 Protected Resource Metadata on the shared listener.

## §auth-oauth 1. Resource Metadata and Bearer Verification

- **Daemon module (`@plurnk/plurnk-auth/module`):** Composed statically by `@plurnk/plurnk-service` ({§module-lifecycle}). When `PLURNK_AUTH_ISSUER` is empty, the module claims no mounts, publishes no `CredentialFace`, and leaves the daemon in unauthenticated loopback/proxy mode. When `PLURNK_AUTH_ISSUER` is non-empty, the module claims `/.well-known/oauth-protected-resource` on the shared listener ({§http-host}), publishes `{ issuer, verify }` onto `seam.credentials` at `setup` ({§credential-authority}), and mounts `GET` / `HEAD` / `OPTIONS /.well-known/oauth-protected-resource` at `start`.
- **Resource origin vs. external authorization server:** `face.issuer(req)` resolves the daemon's own public resource origin (`https://<forwarded-or-host>` when `X-Forwarded-Proto: https` arrives over a loopback listener socket, else `requestOrigin(req, listener)`, {§http-host}), whereas `authorization_servers` names the external `[PLURNK_AUTH_ISSUER]`.
- **JWKS discovery & JWT verification (`jose`):** Discovers `jwks_uri` from `<issuer>/.well-known/openid-configuration` with RFC 8414 fallback (`/.well-known/oauth-authorization-server`), verifying metadata `issuer` match and HTTPS (or loopback HTTP) `jwks_uri` transport. Verifies signature, `iss`, `exp`, `nbf`, non-empty `sub`, optional `aud` (`PLURNK_AUTH_AUDIENCE` or `PLURNK_AUTH_CLIENT_ID`), and optional `PLURNK_AUTH_USERS` (`sub` exact match or case-insensitive `email` when `email_verified === true`). When `sub` matches `PLURNK_AUTH_DELEGATES` (after `PLURNK_AUTH_USERS` admission), `VerifiedBearerClaims` sets `canDelegateActor: true` so authenticated bridges may attribute non-default exterior speakers ({§acp-http-authorization}).

| Path / Behavior | Standard | Contract |
|---|---|---|
| `GET` / `HEAD /.well-known/oauth-protected-resource` | RFC 9728 | Uncacheable JSON carrying `resource` (`<resource-origin>`), `authorization_servers: [<PLURNK_AUTH_ISSUER>]`, `scopes_supported`, `bearer_methods_supported: ["header"]`, `resource_name: "Plurnk"`, optional `client_id` (`PLURNK_AUTH_CLIENT_ID` when non-empty), and `redirect_uri` (`PLURNK_AUTH_CALLBACK` or `<resource-origin>/auth/callback`). |
| `OPTIONS /.well-known/oauth-protected-resource` | CORS | `204` carrying `access-control-allow-origin: <PLURNK_AUTH_ALLOW_ORIGIN>` when non-empty. |
| Problems | RFC 9457 | `service-stopping` (`503`), `method-not-allowed` (`405`), and `route-not-found` (`404`). |

## §auth-configuration 2. Module Configuration

Validated from the assembled environment at module creation ({§operator-config-precedence}); invalid values fail boot, and explicit `Module.create` options override environment keys:

| Input | Empty | Accepted value | Effect |
|---|---|---|---|
| `PLURNK_AUTH_ISSUER` | Disabled (zero mounts, no face) | `https://...` URL (or loopback `http://127.0.0.1` / `localhost` / `[::1]`) without query/fragment | Enables OIDC / OAuth 2.1 JWT verification against the external issuer ({§auth-oauth}). |
| `PLURNK_AUTH_CLIENT_ID` | Omitted from metadata | String | Public PKCE `client_id` advertised in `/.well-known/oauth-protected-resource` and fallback `aud`. |
| `PLURNK_AUTH_AUDIENCE` | Falls back to `PLURNK_AUTH_CLIENT_ID` (unrestricted if both empty) | String | Required JWT `aud` claim during verification. |
| `PLURNK_AUTH_CALLBACK` | `<resource-origin>/auth/callback` | Absolute `http(s)://` URL without fragment | Advertised `redirect_uri` hint for browser OIDC PKCE clients. |
| `PLURNK_AUTH_SCOPES` | `[]` | Space- or comma-separated scope tokens | Advertised `scopes_supported` in `/.well-known/oauth-protected-resource`. |
| `PLURNK_AUTH_USERS` | Admit all users of `PLURNK_AUTH_ISSUER` | Comma-separated `sub` or verified `email` list | Restricts admission to matching `sub` or `email_verified === true` `email`. |
| `PLURNK_AUTH_DELEGATES` | No actor delegation | Comma-separated `sub` list | Grants `canDelegateActor: true` to matching admitted `sub` identifiers so authenticated bridges may attribute non-default exterior speakers. |
| `PLURNK_AUTH_ALLOW_ORIGIN` | Omits CORS headers | `*` or one `http(s)` origin | `access-control-allow-origin` value on `/.well-known/oauth-protected-resource`. |
