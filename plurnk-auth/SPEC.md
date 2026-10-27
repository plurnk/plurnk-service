# @plurnk/plurnk-auth — the OAuth 2.1 authorization server

The module is the OAuth 2.1 authorization server of the daemon's one credential
authority ({§credential-authority}). It publishes the authority's issuing face
and mounts the standard discovery, authorization, token, revocation,
registration and browser-session endpoints on the daemon's listener.

## §auth-oauth Authentication

<!-- map -->
| Tag | Promise |
| --- | --- |
| {§auth-daemon-module} | The module is a discovered module of the daemon. |
| {§auth-oauth-authority} | One authority, scoped by resource. |
| {§auth-oauth-endpoints} | The endpoints live on the daemon's listener, under the issuer. |
| {§auth-oauth-clients} | Four kinds of client. |
| {§auth-oauth-session} | A browser is the operator only once it signs in. |
| {§auth-oauth-documents} | The authorization server's documents are plain semantic HTML. |
| {§auth-oauth-login} | The operator signs in at the authorization endpoint. |
| {§auth-oauth-tokens} | Credentials are opaque and bounded. |
| {§auth-oauth-revocation} | Revocation ends the grant's family. |
| {§auth-cors} | Every response carries `access-control-allow-origin` with the value of `PLURNK_AUTH_ALLOW_ORIGIN`. |
| {§problems-auth} | Auth Problems. |
<!-- /map -->

§auth-daemon-module **The module is a discovered module of the daemon.** The package declares `plurnk: { kind: "module", module: "./module" }` and the daemon discovers it ({§module-discovery}); nothing composes it by hand. The daemon authenticates under the shared `PLURNK_AUTH=1` ({§operator-config-shared-keys}), the shipped posture, and never by inference from what else is set: then the module claims `/oauth`, `/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource` on the daemon's listener ({§http-host}, {§module-http-mounts}), publishes the authority's face at setup, and mounts the endpoints at `start`. Under `PLURNK_AUTH=0` it claims no mounts, publishes nothing, and serves none of them. A daemon without a listener leaves an authenticating module out.

§auth-oauth-authority **One authority, scoped by resource.** A credential carries the scopes of the resources it may reach; `acp` names the ACP client interface ({§acp-http-authorization}), and each mounted resource admits only a token carrying its own scope. Grants are authorization code with PKCE (`S256`, required) for public clients, `client_credentials` for confidential clients, and `refresh_token`; no password or implicit grant exists (RFC 9700). Nothing about a credential is interpreted by a consumer: every answer about one comes from the authority.

§auth-oauth-endpoints **The endpoints live on the daemon's listener, under the issuer.** The issuer is `PLURNK_AUTH_ISSUER`, or, when that is empty, the origin each request reached the daemon at ({§http-host}), answered from setup: the host has bound its listener by then ({§http-host}). The module claims and mounts them on the shared listener ({§module-http-mounts}):

| Path | Standard | Contract |
|---|---|---|
| `/.well-known/oauth-authorization-server` | RFC 8414 | The issuer, its endpoints, `code` as the response type, the three grant types, `S256`, the client authentication methods (`client_secret_basic`, `client_secret_post`, `none`) and the scopes. |
| `/.well-known/oauth-protected-resource` | RFC 9728 | The resource `<issuer>`, this issuer as its authorization server, its scopes and `header` as the bearer method; every 401 from a protected resource names this document. |
| `GET`/`POST /oauth/authorize` | RFC 6749 §4.1, RFC 7636 | The sign-in page ({§auth-oauth-login}) and the authorization code: sixty seconds, bound to the client, the redirect, the challenge, the scopes and a family, the browser session's for a module's own client and a fresh one for any other ({§auth-oauth-session}), spent by its first presentation whatever the outcome. |
| `POST /oauth/token` | RFC 6749 §5, RFC 8707 | The grants; `resource`, when present, must be `<issuer>` or `<issuer>/<scope>`. Errors use the §5.2 JSON (`invalid_request`, `invalid_client` as 401 with a `Basic` challenge when Basic was used, `invalid_grant`, `unauthorized_client`, `unsupported_grant_type`, `invalid_scope`, `invalid_target`). |
| `POST /oauth/revoke` | RFC 7009 | Revokes the family of a live token the authenticated client owns; any other token answers 200 and revokes nothing. |
| `POST /oauth/register` | RFC 7591 | Registers a public client (`token_endpoint_auth_method: none`) with absolute http(s) redirect URIs; a confidential client is declared, never registered. |
| `GET`/`POST /oauth/session` | — | The browser's standing ({§auth-oauth-session}): `GET` says whether this browser holds a session; `POST` with `action=end` revokes it and clears the cookie. |

Every response is uncacheable; OPTIONS answers 204 and the CORS headers follow {§auth-cors}. A redirect URI must match a registered one exactly, except that a registered public client's loopback redirect may change its port (RFC 8252 §7.3). A module's own client is answered only at the issuer followed by a path it registered ({§credential-authority}), with no exception: under a configured issuer no other origin is its address. A request naming an unregistered client or redirect is answered to the person, never redirected; any other malformed request is redirected with its `error` and `state`.

§auth-oauth-clients **Four kinds of client.** A scope a module client registered that this server does not issue is the module's fault and fails the request as a server error, never as a narrowed grant; a declared client may not take a module client's id.

| Client | Kind | Secret | Scopes | Grants and subject |
| --- | --- | --- | --- | --- |
| `operator`, the operator's own | confidential | the authority's operator secret ({§credential-authority}): the shared `PLURNK_SECRET` when set, otherwise the one the daemon mints at boot into the file beside its database; an authority without an operator secret has no `operator` client, and the operator's tools have no way in but the sign-in | every scope | the terminal client, scripts and the bench exchange it for access tokens with `client_credentials` |
| A declared client, `PLURNK_AUTH_CLIENT_<id>={"secret":"…","scopes":[…]}` | confidential | as declared | only the scopes declared | its tokens name it as their subject; removing its line and restarting revokes them |
| A registered client | public: nothing to keep, authenticates by its id alone | none | as registered | only the code grant with PKCE and refresh; its tokens name the operator who signed in; may not use `client_credentials` (`unauthorized_client`) |
| A module's own client, one a module of this daemon registered on the authority ({§credential-authority}) | confidential, as RFC 10017 §6.2.3.1 requires of a backend that holds tokens for a page | the secret the authority minted and checks, by `client_secret_basic` or `client_secret_post` | as registered | the code grant with PKCE and refresh, its tokens naming the operator who authorized it; may not use `client_credentials` (`unauthorized_client`): it stands for the operator, never for itself |

§auth-oauth-session **A browser is the operator only once it signs in.** The browser's standing is a `session` credential of the authority ({§credential-authority}), presented as the cookie `plurnk_session` (`HttpOnly`, `SameSite=Lax`, `Path=/oauth`, `Secure` under an https issuer), living as long as a refresh token and revoked by `POST /oauth/session` with `action=end`, which also clears the cookie; a session is never a bearer. Signing in with `PLURNK_PASS` ({§auth-oauth-login}) is the only way a session is established, wherever the browser runs: while it is empty, every browser is told so, and where to set it, at 503 and no session exists.

| Client | What the session does for it |
| --- | --- |
| A module's own client ({§auth-oauth-clients}) | this daemon's by registration, and the operator's session authorizes it silently; having no standing apart from that sign-in, its grant joins the session's family, so revoking the family from either side, by `/oauth/session` or by the module's own sign-out, ends the browser's standing here and the module's credentials together, and a code not yet exchanged ends with them; the next visit after a sign-out meets the sign-in form |
| Any other client, wherever its redirect points | shown a consent page naming it and its scopes, and only a `POST` carrying the session that preceded the request issues the code (`consent=allow`) or declines it (`consent=deny`, `access_denied` to the redirect), so a page elsewhere, whose cross-site POST carries no cookie and whose top-level GET cannot click, obtains nothing |

Every request under the authorization server's paths is answered at the address it reached the daemon by ({§http-host}): no `Host` is refused, so a page that rebinds a name to the daemon's address reaches it under that name. Every page it serves carries `frame-ancestors 'none'`.

§auth-oauth-documents **The authorization server's documents are plain semantic HTML.** Every page it shows a person (sign-in, a refused password, too many attempts, no password, consent, a refused request, and the session page) is HTML with no script and no class. `authorizationDocumentSpecimens()` renders every one of these documents, for a consumer whose production CSS pruning must keep the selectors they use.

| Fact | Rule |
| --- | --- |
| Structure | a `main` holding one `article` whose `header` carries the `h1`, paragraphs, and native form controls each named by its `label`; a page that reports a fault puts a warning glyph (`role="img"`, `aria-label="Warning"`) in its heading, and a refused password is an alert (`role="alert"`) |
| Style | a page carries its own small inline style, readable alone in either color scheme |
| A module client's stylesheet | on a request whose `client_id` names a module client that registered a stylesheet ({§credential-authority}), the page links that stylesheet in place of its own style, and its policy admits same-origin styles only (`style-src 'self'`); the session page takes an optional `client_id` for the same purpose and carries it through its sign-out |
| Any other request | can name a registered client and nothing else: no page links a stylesheet a request supplies, and a client that is unknown, not a module's or registered none gets the standalone page |

§auth-oauth-login **The operator signs in at the authorization endpoint.** The sign-in page is plain HTML with no script: it names the client and the scopes it asks for and posts the operator's shared password, `PLURNK_PASS`, compared in constant time. There is one local operator: the password selects no account, and the session's subject is the operator's whatever the password is, so changing it changes who can sign in, never who they are or what they own.

| Password | Result |
| --- | --- |
| Wrong | the form again, at 401 |
| Right | the browser's session ({§auth-oauth-session}) and a redirect with the code and the `state` |
| Empty (`PLURNK_PASS` ships empty) | every browser is told so, and the operator's configuration file to set it in, at 503 and issued nothing; client credentials are unaffected |
| Many attempts | the daemon does not throttle failed attempts: limiting requests by their real source is the job of a front such as the example nginx configuration ({§nginx-example}), which sees addresses a proxied daemon cannot |

§auth-oauth-tokens **Credentials are opaque and bounded.** An access token lives `PLURNK_AUTH_ACCESS_TTL_SEC`, a refresh token `PLURNK_AUTH_REFRESH_TTL_SEC`; both are random strings the authority holds in memory, so a daemon restart revokes every credential and a client simply acquires again. A refresh token rotates: each use consumes it and answers a new access token and a new refresh token of the same family, with the same or a narrower scope; a consumed refresh token presented again is reuse, and reuse revokes the whole family (RFC 9700 §4.14). A code grant and a refresh grant answer a refresh token; `client_credentials` answers an access token alone, renewed with the secret.

§auth-oauth-revocation **Revocation ends the grant's family.** Revoking a family — by the revocation endpoint, by refresh-token reuse, by a code presented twice or by ending a browser's session, which for a module's own client is the same family ({§auth-oauth-session}) — revokes every live and retired token of that family on the authority and notifies every subscribed face ({§credential-authority}).

§auth-cors **Every response carries `access-control-allow-origin` with the value of `PLURNK_AUTH_ALLOW_ORIGIN`.** It allows the `content-type` and `authorization` request headers; an empty value sends neither header. A preflight is answered `204`.

§problems-auth **Auth Problems.** Every code minted here, its status, and the sentence that is its contract.

| code | status | contract |
|---|---:|---|
| `service-stopping` | 503 | The service is shutting down. |
| `route-not-found` | 404 | The requested HTTP route does not exist. |

## §auth-configuration Module configuration

The daemon assembles installed package defaults through {§operator-config-env-defaults}; `@plurnk/plurnk-auth` reads and validates its own keys from that environment as the daemon discovers it, and an invalid value fails boot. Explicit `Module.create` options override their corresponding environment values.

| Input | Owner | Empty or absent | Accepted value | Effect |
| --- | --- | --- | --- | --- |
| `PLURNK_AUTH` | Shared | Invalid; the shared panel is required | `1` or `0` | The daemon's posture ({§credential-authority}, {§operator-config-shared-keys}): authenticate, or admit anonymously. |
| `PLURNK_SECRET` | Shared | The daemon mints one at boot | Any non-empty string | The operator's client secret ({§auth-oauth-clients}), what the operator's own tools exchange for access tokens. |
| `PLURNK_PASS` | Shared | Empty: no browser signs in until it is set ({§auth-oauth-session}) | Any string | The operator's browser sign-in password ({§auth-oauth-login}). |
| `PLURNK_AUTH_ISSUER` | Auth | The origin each request reached ({§http-host}) | An absolute http(s) origin | The authorization server's issuer, the public origin clients reach ({§auth-oauth-endpoints}). |
| `PLURNK_AUTH_ACCESS_TTL_SEC` / `PLURNK_AUTH_REFRESH_TTL_SEC` | Auth | Invalid; the package floor is required | Positive safe integers | Credential lifetimes ({§auth-oauth-tokens}). |
| `PLURNK_AUTH_CLIENT_<id>` | Auth | No declared clients | `{"secret": "…", "scopes": ["acp"]}` | One confidential client per line ({§auth-oauth-clients}); `operator` is reserved. |
| `PLURNK_AUTH_ALLOW_ORIGIN` | Auth | Empty: no CORS headers; absent: invalid | `*` or one origin | The origin whose pages a browser lets read replies ({§auth-cors}). |
