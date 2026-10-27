# @plurnk/plurnk-auth — the OAuth 2.1 authorization server

The module is the OAuth 2.1 authorization server of the daemon's credential authority ({§credential-authority}), publishing the authority's issuing face and mounting discovery, authorization, token, revocation, registration, and browser-session endpoints on the daemon's listener.

## §auth-oauth 1. Authentication and OAuth 2.1 Endpoints

- **Daemon module (`plurnk: { kind: "module", module: "./module" }`):** Discovered automatically ({§module-lifecycle}). Active under `PLURNK_AUTH=1` ({§operator-config-precedence}), claiming `/oauth`, `/.well-known/oauth-authorization-server`, and `/.well-known/oauth-protected-resource` on the shared listener ({§http-host}), publishing the authority's face at `setup`, and mounting endpoints at `start`. Under `PLURNK_AUTH=0` (or without a listener) it claims no mounts, publishes nothing, and serves nothing.
- **Resource-scoped authority:** Credentials carry resource scopes (`acp` names `/acp`, {§acp-http-authorization}); each mounted resource admits only tokens carrying its scope. Supported grants are authorization code with PKCE (`S256` required) for public/module clients, `client_credentials` for confidential clients, and `refresh_token` (no password or implicit grant, RFC 9700).
- **Issuer & endpoints:** The issuer is `PLURNK_AUTH_ISSUER`, or when empty the request origin ({§http-host}). Every response is uncacheable; `OPTIONS` answers `204` and every response carries `access-control-allow-origin: <PLURNK_AUTH_ALLOW_ORIGIN>` (allowing `content-type` and `authorization` when non-empty).

| Path | Standard | Contract |
|---|---|---|
| `/.well-known/oauth-authorization-server` | RFC 8414 | Issuer, endpoints, `response_types_supported: ["code"]`, the 3 grant types, `S256`, auth methods (`client_secret_basic`, `client_secret_post`, `none`), and scopes. |
| `/.well-known/oauth-protected-resource` | RFC 9728 | Resource `<issuer>`, authorization server `<issuer>`, scopes, and `bearer_methods_supported: ["header"]` (named in every `401` challenge). |
| `GET`/`POST /oauth/authorize` | RFC 6749 §4.1, RFC 7636 | Sign-in/consent page and 60s single-use authorization code bound to client, redirect URI, PKCE challenge, scopes, and grant family. Exact redirect match required except registered public loopback port changes (RFC 8252 §7.3); module clients require `<issuer><registered-path>`. Unregistered client/redirect renders an error page; other malformed requests redirect with `error` and `state`. |
| `POST /oauth/token` | RFC 6749 §5, RFC 8707 | Token exchange; optional `resource` must be `<issuer>` or `<issuer>/<scope>`. Errors use §5.2 JSON (`invalid_request`, `invalid_client` at `401` with `Basic` challenge when Basic was used, `invalid_grant`, `unauthorized_client`, `unsupported_grant_type`, `invalid_scope`, `invalid_target`). |
| `POST /oauth/revoke` | RFC 7009 | Revokes the family of a live token owned by the authenticated client; any other token answers `200` and revokes nothing. |
| `POST /oauth/register` | RFC 7591 | Registers a public client (`token_endpoint_auth_method: "none"`) with absolute `http(s)` redirect URIs; confidential clients are declared, never registered. |
| `GET`/`POST /oauth/session` | — | Browser session standing: `GET` reports session state; `POST` with `action=end` revokes the session family and clears `plurnk_session`. |
| Problems | RFC 9457 | `service-stopping` (`503`: The service is shutting down) and `route-not-found` (`404`: The requested HTTP route does not exist). |

### §auth-oauth-clients 1.1 Clients, Browser Sessions, and HTML Documents

| Client kind | Secret & auth | Scopes | Grants, subject & session behavior |
|---|---|---|---|
| `operator` (confidential) | Shared `PLURNK_SECRET` or boot-minted secret file beside DB (absent if none) | Every scope | `client_credentials` for terminal client, scripts, and bench. |
| Declared `PLURNK_AUTH_CLIENT_<id>` (confidential) | Declared `secret` (`operator` id reserved; cannot take a module client id) | Declared `scopes` | `client_credentials`; subject is `<id>`; removing the env entry and restarting revokes its tokens. |
| Registered public client | None (`none`) | Registered scopes | Code + PKCE + refresh only (`client_credentials` $\to$ `unauthorized_client`); subject is operator; shown consent page (`consent=allow` \| `consent=deny` $\to$ `access_denied`). |
| Module client ({§credential-authority}, confidential per RFC 10017 §6.2.3.1) | Authority-minted secret (`client_secret_basic` / `client_secret_post`) | Registered scopes (unissued scope is a server error) | Code + PKCE + refresh only (`client_credentials` $\to$ `unauthorized_client`); authorized silently by the operator's browser session and shares its grant family. |

- **Browser session (`plurnk_session`):** `HttpOnly`, `SameSite=Lax`, `Path=/oauth`, `Secure` under `https`, living as long as a refresh token; never accepted as a bearer token. Established only by posting `PLURNK_PASS` (constant-time comparison) at `/oauth/authorize`: wrong password re-renders the form at `401` (`role="alert"`); right password sets `plurnk_session` and redirects with `code` and `state`; empty `PLURNK_PASS` answers `503` naming the config file (`client_credentials` unaffected); no request `Host` is refused and every HTML response sets `frame-ancestors 'none'`.
- **Plain semantic HTML (`authorizationDocumentSpecimens()`):** Every human-facing page is scriptless, classless HTML (`<main><article><header><h1>...` with labeled controls and `role="img" aria-label="Warning"` on fault headings) with inline dual-scheme CSS—or `<link rel="stylesheet">` + `style-src 'self'` when `client_id` names a module client that registered a stylesheet.

### §auth-oauth-tokens 1.2 Tokens and Revocation

- **Opaque in-memory tokens:** Access tokens live `PLURNK_AUTH_ACCESS_TTL_SEC` and refresh tokens live `PLURNK_AUTH_REFRESH_TTL_SEC`; daemon restart revokes all credentials.
- **Refresh rotation & family revocation:** Each refresh consumes the presented refresh token and issues a new access + refresh token in the same family (same or narrower scope). Presenting a consumed refresh token or a spent authorization code, calling `/oauth/revoke`, or ending a linked browser session revokes every live and retired token in that family and notifies subscribed faces ({§credential-authority}). `client_credentials` issues an access token only.

## §auth-configuration 2. Module Configuration

Validated from the assembled environment at discovery ({§operator-config-precedence}); invalid values fail boot, and explicit `Module.create` options override environment keys:

| Input | Owner | Empty or absent | Accepted value | Effect |
|---|---|---|---|---|
| `PLURNK_AUTH` | Shared | Invalid (required) | `1` or `0` | Authenticate (`1`) or admit anonymously (`0`). |
| `PLURNK_SECRET` | Shared | Daemon mints one at boot | Non-empty string | Secret for the `operator` client ({§auth-oauth-clients}). |
| `PLURNK_PASS` | Shared | Empty disables browser sign-in (`503`) | Any string | Operator browser sign-in password ({§auth-oauth-clients}). |
| `PLURNK_AUTH_ISSUER` | Auth | Request origin ({§http-host}) | Absolute `http(s)` origin | Public OAuth issuer origin ({§auth-oauth}). |
| `PLURNK_AUTH_ACCESS_TTL_SEC` / `PLURNK_AUTH_REFRESH_TTL_SEC` | Auth | Invalid (floor required) | Positive safe integers | Access and refresh token lifetimes in seconds ({§auth-oauth-tokens}). |
| `PLURNK_AUTH_CLIENT_<id>` | Auth | No declared clients | `{"secret":"…","scopes":["acp"]}` | Declares confidential client `<id>` (`operator` reserved). |
| `PLURNK_AUTH_ALLOW_ORIGIN` | Auth | Empty omits CORS; absent invalid | `*` or one origin | `access-control-allow-origin` value ({§auth-oauth}). |
