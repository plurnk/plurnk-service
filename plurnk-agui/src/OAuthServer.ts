// {§agui-oauth} — the daemon's OAuth 2.1 authorization server, the issuing face of the daemon's one
// credential authority ({§credential-authority}): discovery (RFC 8414, RFC 9728), the operator's login
// and authorization code with PKCE (RFC 6749 §4.1, RFC 7636), client credentials (§4.4), refresh with
// rotation, revocation (RFC 7009) and public-client registration (RFC 7591), all on the daemon's one
// listener. Bearer admission for a protected resource is here too (RFC 6750).
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CredentialAuthority, CredentialClaims, ProblemDetails } from "@plurnk/plurnk-contracts";
import { AuthorizationDocuments, renderAuthorizationDocument, type AuthorizationDocument, type AuthorizationRequest } from "./AuthorizationDocuments.ts";
import { OPERATOR_CLIENT, SCOPES, type ResolvedModuleOptions } from "./config.ts";
import { httpProblem } from "./run-events.ts";

// Mechanism, not choices ({§operator-config-only-home}); each is registered in the root's mechanism list.
const CODE_TTL_MS = 60_000;
const MAX_BODY_BYTES = 65_536;
const MAX_REGISTERED_CLIENTS = 1_000;

// {§agui-oauth-login} — the one local operator, the subject of every grant made for them whatever password
// signed them in. Their built-in client shares the spelling; a client id is not a subject.
const OPERATOR_SUBJECT = "operator";
// {§agui-oauth-session} — the browser session's cookie, scoped to the authorization server's paths.
const SESSION_COOKIE = "plurnk_session";
const BROWSER = "browser";
const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/u;
const SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]+$/u;

interface Client {
    readonly id: string;
    /**
     * {§agui-oauth-clients} `public` registered itself and holds nothing; `declared` is the operator's
     * own or a configured client, with its secret; `module` is a daemon module's own client, whose
     * secret the authority holds and checks.
     */
    readonly kind: "public" | "declared" | "module";
    /** The secret of a `declared` client; null for the other two kinds. */
    readonly secret: string | null;
    /** {§agui-oauth-documents} A `module` client's registered stylesheet path; null for every other client. */
    readonly stylesheet: string | null;
    readonly scopes: readonly string[];
    readonly redirectUris: readonly string[];
    readonly name: string | null;
}

interface Code {
    readonly clientId: string;
    readonly redirectUri: string;
    readonly challenge: string;
    readonly scopes: readonly string[];
    readonly family: string;
    readonly expiresAt: number;
}

export type Admission =
    | { readonly ok: true; readonly principal: string; readonly family: string | null }
    | { readonly ok: false; readonly problem: ProblemDetails; readonly challenge: string };

// RFC 6749 §5.2 — an error code, its description and the status it is answered with.
class OAuthError extends Error {
    readonly code: string;
    readonly description: string;
    readonly status: number;

    constructor(code: string, description: string, status = 400) {
        super(description);
        this.code = code;
        this.description = description;
        this.status = status;
    }
}

const sha256 = (value: string): Buffer => createHash("sha256").update(value).digest();
// Constant-time equality over digests: lengths never leak, and a secret compares in fixed time.
const same = (a: string, b: string): boolean => timingSafeEqual(sha256(a), sha256(b));
const mint = (): string => randomBytes(32).toString("base64url");

const readBody = (req: IncomingMessage): Promise<string> => new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
            reject(new OAuthError("invalid_request", "The request body is too large.", 413));
            req.destroy();
            return;
        }
        chunks.push(chunk);
    });
    req.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.once("error", reject);
});

const isForm = (req: IncomingMessage): boolean =>
    (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase() === "application/x-www-form-urlencoded";
const isJson = (req: IncomingMessage): boolean =>
    (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase() === "application/json";

const cookieValue = (req: IncomingMessage, name: string): string | null => {
    for (const part of (req.headers.cookie ?? "").split(";")) {
        const separator = part.indexOf("=");
        if (separator !== -1 && part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
    }
    return null;
};

const absoluteHttpUrl = (value: unknown): URL | null => {
    if (typeof value !== "string") return null;
    try {
        const url = new URL(value);
        return (url.protocol === "http:" || url.protocol === "https:") && url.hash === "" ? url : null;
    } catch { return null; }
};

// RFC 8252 §7.3 — a loopback redirect may change its port between registration and use.
const redirectMatches = (registered: string, presented: string): boolean => {
    if (registered === presented) return true;
    const a = absoluteHttpUrl(registered);
    const b = absoluteHttpUrl(presented);
    if (a === null || b === null) return false;
    const loopback = (url: URL): boolean => url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "localhost";
    return loopback(a) && loopback(b) && a.protocol === b.protocol && a.hostname === b.hostname
        && a.pathname === b.pathname && a.search === b.search;
};

export default class OAuthServer {
    readonly #credentials: CredentialAuthority;
    readonly #opts: ResolvedModuleOptions;
    readonly #issuer: (req: Pick<IncomingMessage, "headers">) => string;
    readonly #clients = new Map<string, Client>();
    readonly #codes = new Map<string, Code>();
    // {§agui-oauth-login} — failures per source address within the configured window.
    readonly #failures = new Map<string, { count: number; windowStart: number }>();
    readonly #now: () => number;
    #registered = 0;

    constructor({ credentials, opts, issuer, now = Date.now }: {
        readonly credentials: CredentialAuthority;
        readonly opts: ResolvedModuleOptions;
        readonly issuer: (req: Pick<IncomingMessage, "headers">) => string;
        readonly now?: () => number;
    }) {
        this.#credentials = credentials;
        this.#opts = opts;
        this.#issuer = issuer;
        this.#now = now;
        // {§agui-oauth-clients} — the operator's own client holds the authority's operator secret,
        // configured or minted for this boot ({§credential-authority}), and every scope; an authority
        // without one has no such client, and the operator signs in or declares clients instead.
        const operatorSecret = credentials.operatorSecret;
        if (operatorSecret !== null) this.#clients.set(OPERATOR_CLIENT, { id: OPERATOR_CLIENT, kind: "declared", secret: operatorSecret, stylesheet: null, scopes: SCOPES, redirectUris: [], name: null });
        for (const [id, declared] of Object.entries(opts.clients)) {
            if (credentials.client(id) !== null) throw new Error(`PLURNK_AGUI_CLIENT_${id}: '${id}' is the id of a module's own client; declare another id.`);
            this.#clients.set(id, { id, kind: "declared", secret: declared.secret, stylesheet: null, scopes: declared.scopes, redirectUris: [], name: null });
        }
        // {§agui-oauth-session} — a code not yet exchanged ends with the family it would issue into, so
        // a sign-in ended between authorization and exchange stays ended.
        credentials.onRevoked((family) => {
            for (const [code, pending] of this.#codes) if (pending.family === family) this.#codes.delete(code);
        });
    }

    // {§http-request-origin} — every address this server advertises is answered for the request that asks.
    resource(req: Pick<IncomingMessage, "headers">): string { return `${this.#issuer(req)}/agui`; }

    /** {§agui-oauth-endpoints} RFC 8414 */
    metadata(req: Pick<IncomingMessage, "headers">): Record<string, unknown> {
        const issuer = this.#issuer(req);
        return {
            issuer,
            authorization_endpoint: `${issuer}/oauth/authorize`,
            token_endpoint: `${issuer}/oauth/token`,
            revocation_endpoint: `${issuer}/oauth/revoke`,
            registration_endpoint: `${issuer}/oauth/register`,
            response_types_supported: ["code"],
            response_modes_supported: ["query"],
            grant_types_supported: ["authorization_code", "client_credentials", "refresh_token"],
            token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
            revocation_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
            code_challenge_methods_supported: ["S256"],
            scopes_supported: [...SCOPES],
        };
    }

    /** {§agui-oauth-endpoints} RFC 9728 */
    resourceMetadata(req: Pick<IncomingMessage, "headers">): Record<string, unknown> {
        return {
            resource: this.resource(req),
            authorization_servers: [this.#issuer(req)],
            scopes_supported: [...SCOPES],
            bearer_methods_supported: ["header"],
            resource_name: "Plurnk AG-UI",
        };
    }

    // {§agui-http-authorization} — bearer admission for the AG-UI resource (RFC 6750 §3).
    admit(req: IncomingMessage, scope: string): Admission {
        const header = req.headers.authorization;
        const challenge = (parameters: string): string => `Bearer realm="plurnk"${parameters}, resource_metadata="${this.#issuer(req)}/.well-known/oauth-protected-resource"`;
        const presented = header === undefined ? null : /^Bearer(?:\s+(.*))?$/iu.exec(header);
        if (presented === null) {
            return {
                ok: false,
                challenge: challenge(""),
                problem: httpProblem("bearer-token-required", 401, "The request did not provide a bearer token.", {
                    stage: "authorization", recovery: "Present an access token issued by this daemon as `Authorization: Bearer <token>`.", retryable: false,
                }),
            };
        }
        const token = (presented[1] ?? "").trim();
        const claims = this.#credentials.verify(token);
        if (claims === null || claims.kind !== "access") {
            return {
                ok: false,
                challenge: challenge(', error="invalid_token", error_description="The access token is unknown, expired or revoked."'),
                problem: httpProblem("bearer-token-invalid", 401, "The access token is unknown, expired or revoked.", {
                    stage: "authorization", recovery: "Obtain a new access token from this daemon's token endpoint.", retryable: false,
                }),
            };
        }
        if (!claims.scopes.includes(scope)) {
            return {
                ok: false,
                challenge: challenge(`, error="insufficient_scope", scope="${scope}"`),
                problem: httpProblem("bearer-scope-insufficient", 403, `The access token does not carry the scope ${scope}.`, {
                    stage: "authorization", scope, recovery: `Obtain an access token with the scope ${scope}.`, retryable: false,
                }),
            };
        }
        return { ok: true, principal: claims.subject, family: claims.family };
    }

    /** Routes one request under `/oauth` or a well-known document; answers true when it was one of ours. */
    async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
        const pathname = new URL(req.url ?? "/", "http://host").pathname;
        const route = this.#routes()[pathname];
        if (route === undefined) return false;
        try {
            await route(req, res);
        } catch (cause) {
            const error = cause instanceof OAuthError ? cause : new OAuthError("server_error", "The authorization server failed.", 500);
            if (!(cause instanceof OAuthError)) console.error("OAuth request failed:", cause);
            this.#json(res, error.status, { error: error.code, error_description: error.description },
                error.code === "invalid_client" && /^Basic\s/iu.test(req.headers.authorization ?? "") ? { "www-authenticate": 'Basic realm="plurnk"' } : {});
        }
        return true;
    }

    #routes(): Record<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>> {
        return {
            "/.well-known/oauth-authorization-server": async (req, res) => this.#document(req, res, this.metadata(req)),
            "/.well-known/oauth-protected-resource": async (req, res) => this.#document(req, res, this.resourceMetadata(req)),
            "/oauth/authorize": (req, res) => this.#authorize(req, res),
            "/oauth/token": (req, res) => this.#token(req, res),
            "/oauth/revoke": (req, res) => this.#revoke(req, res),
            "/oauth/register": (req, res) => this.#register(req, res),
            "/oauth/session": (req, res) => this.#sessionPage(req, res),
        };
    }

    // ── session ───────────────────────────────────────────────────────────

    // {§agui-oauth-session} — the browser's session is a credential of the authority, presented as a cookie.
    #session(req: IncomingMessage): CredentialClaims | null {
        const token = cookieValue(req, SESSION_COOKIE);
        if (token === null) return null;
        const claims = this.#credentials.verify(token);
        return claims !== null && claims.kind === "session" ? claims : null;
    }

    #establishSession(req: IncomingMessage, res: ServerResponse): CredentialClaims {
        const ttlMs = this.#opts.refreshTtlSec * 1000;
        const family = randomUUID();
        const issued = this.#credentials.issue({ kind: "session", subject: OPERATOR_SUBJECT, clientId: BROWSER, scopes: SCOPES, family, ttlMs });
        res.setHeader("set-cookie", `${SESSION_COOKIE}=${issued.token}; Path=/oauth; Max-Age=${this.#opts.refreshTtlSec}; HttpOnly; SameSite=Lax${this.#issuer(req).startsWith("https:") ? "; Secure" : ""}`);
        return { kind: "session", subject: OPERATOR_SUBJECT, clientId: BROWSER, scopes: SCOPES, family, expiresAt: issued.expiresAt };
    }

    #endSession(req: IncomingMessage, res: ServerResponse): void {
        const session = this.#session(req);
        if (session !== null) this.#credentials.revokeFamily(session.family);
        res.setHeader("set-cookie", `${SESSION_COOKIE}=; Path=/oauth; Max-Age=0; HttpOnly; SameSite=Lax`);
    }

    // {§agui-oauth-clients} {§credential-module-client} — a module's own client is the authority's to know; every other client is
    // this server's. A module client naming a scope this server does not issue is a fault of the module.
    // Its redirect addresses are its registered paths on the issuer, formed when asked.
    #client(id: string, req: Pick<IncomingMessage, "headers">): Client | undefined {
        const registered = this.#credentials.client(id);
        if (registered === null) return this.#clients.get(id);
        const foreign = registered.scopes.find((scope) => !SCOPES.includes(scope));
        if (foreign !== undefined) throw new Error(`the module client '${id}' registered the scope '${foreign}', which this authorization server does not issue`);
        const issuer = this.#issuer(req);
        return { id, kind: "module", secret: null, stylesheet: registered.stylesheetPath ?? null, scopes: registered.scopes, redirectUris: registered.redirectPaths.map((path) => `${issuer}${path}`), name: null };
    }

    // {§agui-oauth-endpoints} — a module's client is answered only at its path on the issuer; any other
    // client at a registered address, a loopback one on any port (RFC 8252 §7.3).
    static #redirects(client: Client, presented: string): boolean {
        return client.kind === "module"
            ? client.redirectUris.includes(presented)
            : client.redirectUris.some((registered) => redirectMatches(registered, presented));
    }

    async #sessionPage(req: IncomingMessage, res: ServerResponse): Promise<void> {
        if (req.method === "POST") {
            const form = await this.#form(req);
            if (form.get("action") !== "end") throw new OAuthError("invalid_request", "POST action=end to sign this browser out.");
            this.#endSession(req, res);
            this.#html(res, 200, AuthorizationDocuments.signedOut(), this.#stylesheet(form.get("client_id")));
            return;
        }
        if (req.method !== "GET") throw new OAuthError("invalid_request", "Use GET, or POST a form.", 405);
        const clientId = new URL(req.url ?? "/", "http://host").searchParams.get("client_id");
        const stylesheet = this.#stylesheet(clientId);
        this.#html(res, 200, this.#session(req) === null
            ? AuthorizationDocuments.notSignedIn()
            : AuthorizationDocuments.signedIn(stylesheet === null ? {} : { client_id: clientId! }), stylesheet);
    }

    // {§agui-oauth-documents} — a stylesheet is a module client's registration, which the request can
    // only name, never supply.
    #stylesheet(clientId: string | null): string | null {
        return clientId === null ? null : this.#credentials.client(clientId)?.stylesheetPath ?? null;
    }

    async #document(req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>): Promise<void> {
        if (req.method !== "GET" && req.method !== "HEAD") throw new OAuthError("invalid_request", "Use GET.", 405);
        this.#json(res, 200, body);
    }

    #json(res: ServerResponse, status: number, body: Record<string, unknown>, headers: Record<string, string> = {}): void {
        res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", pragma: "no-cache", ...headers });
        res.end(JSON.stringify(body));
    }

    #html(res: ServerResponse, status: number, document: AuthorizationDocument, stylesheet: string | null, headers: Record<string, string> = {}): void {
        const { html, policy } = renderAuthorizationDocument(document, stylesheet);
        res.writeHead(status, {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "content-security-policy": policy,
            "x-frame-options": "DENY",
            ...headers,
        });
        res.end(html);
    }

    // ── authorization ───────────────────────────────────────────────────────────────────────────

    async #authorize(req: IncomingMessage, res: ServerResponse): Promise<void> {
        let params: URLSearchParams;
        if (req.method === "GET") params = new URL(req.url ?? "/", "http://host").searchParams;
        else if (req.method === "POST" && isForm(req)) params = new URLSearchParams(await readBody(req));
        else throw new OAuthError("invalid_request", "Use GET, or POST a form.", 405);

        // RFC 6749 §4.1.2.1 — a bad client or redirect is told to the person, never redirected to.
        const client = this.#client(params.get("client_id") ?? "", req);
        const redirectUri = params.get("redirect_uri");
        if (client === undefined || redirectUri === null || !OAuthServer.#redirects(client, redirectUri)) {
            this.#html(res, 400, AuthorizationDocuments.refused(), null);
            return;
        }
        const state = params.get("state");
        const fail = (code: string, description: string): void => {
            const target = new URL(redirectUri);
            target.searchParams.set("error", code);
            target.searchParams.set("error_description", description);
            if (state !== null) target.searchParams.set("state", state);
            res.writeHead(302, { location: target.toString(), "cache-control": "no-store" });
            res.end();
        };
        if (params.get("response_type") !== "code") { fail("unsupported_response_type", "Only response_type=code is supported."); return; }
        const challenge = params.get("code_challenge") ?? "";
        if (!PKCE_VERIFIER.test(challenge) || (params.get("code_challenge_method") ?? "") !== "S256") {
            fail("invalid_request", "A code_challenge with code_challenge_method=S256 is required."); return;
        }
        const scopes = this.#scopes(params.get("scope"), client);
        if (scopes === null) { fail("invalid_scope", `The scope must be from ${SCOPES.join(" ")} and within the client's.`); return; }
        const resource = params.get("resource");
        if (resource !== null && resource !== this.resource(req)) { fail("invalid_target", `The resource must be ${this.resource(req)}.`); return; }

        // {§agui-oauth-session} — a module's own client is authorized by the browser's sign-in and by
        // nothing else, so its grant joins that sign-in's family: ending either ends both. Any other
        // client's grant is a standing of its own, in a fresh family.
        const issue = (session: CredentialClaims): void => {
            const code = mint();
            this.#sweepCodes();
            const family = client.kind === "module" ? session.family : randomUUID();
            this.#codes.set(code, { clientId: client.id, redirectUri, challenge, scopes, family, expiresAt: this.#now() + CODE_TTL_MS });
            const target = new URL(redirectUri);
            target.searchParams.set("code", code);
            if (state !== null) target.searchParams.set("state", state);
            res.writeHead(302, { location: target.toString(), "cache-control": "no-store" });
            res.end();
        };
        const request: AuthorizationRequest = {
            client: client.name ?? client.id,
            scopes,
            hidden: Object.fromEntries(["client_id", "redirect_uri", "response_type", "code_challenge", "code_challenge_method", "scope", "state", "resource"]
                .filter((name) => params.has(name)).map((name) => [name, params.get(name)!])),
        };

        // {§agui-oauth-session} — a browser is the operator only once it has signed in. A consent
        // decision counts only with the session the request carries, which a cross-site POST cannot.
        const session = this.#session(req);
        if (session !== null) {
            // A module of this daemon registered this client: the operator's session authorizes it.
            if (client.kind === "module") { issue(session); return; }
            const decision = req.method === "POST" ? params.get("consent") : null;
            if (decision === "allow") { issue(session); return; }
            if (decision === "deny") { fail("access_denied", "The operator declined."); return; }
            this.#html(res, 200, AuthorizationDocuments.consent(request), client.stylesheet);
            return;
        }

        // {§agui-oauth-login} — the operator signs in here. Without a password no browser can: the page
        // says the password is empty and where to set it, and issues nothing.
        if (this.#opts.password.length === 0) {
            this.#html(res, 503, AuthorizationDocuments.noPassword(), client.stylesheet);
            return;
        }
        const password = params.get("password");
        if (req.method === "GET" || password === null) {
            this.#html(res, 200, AuthorizationDocuments.signIn(request, null), client.stylesheet);
            return;
        }
        const address = req.socket.remoteAddress ?? "unknown";
        const retryAfter = this.#limited(address);
        if (retryAfter !== null) {
            this.#html(res, 429, AuthorizationDocuments.tooManyAttempts(retryAfter), client.stylesheet, { "retry-after": String(retryAfter) });
            return;
        }
        if (!same(password, this.#opts.password)) {
            this.#failed(address);
            this.#html(res, 401, AuthorizationDocuments.signIn(request, "The password is wrong."), client.stylesheet);
            return;
        }
        this.#failures.delete(address);
        // A sign-in is the operator's own act, so it issues at once, and the browser keeps the session.
        issue(this.#establishSession(req, res));
    }

    #scopes(requested: string | null, client: Client): readonly string[] | null {
        if (requested === null || requested.trim().length === 0) return client.scopes;
        const scopes = [...new Set(requested.trim().split(/\s+/u))];
        if (scopes.some((scope) => !SCOPE_TOKEN.test(scope) || !client.scopes.includes(scope))) return null;
        return Object.freeze(scopes);
    }

    #limited(address: string): number | null {
        if (this.#opts.loginAttempts === 0) return null;
        const record = this.#failures.get(address);
        if (record === undefined) return null;
        const windowMs = this.#opts.loginWindowSec * 1000;
        if (record.windowStart + windowMs <= this.#now()) { this.#failures.delete(address); return null; }
        if (record.count < this.#opts.loginAttempts) return null;
        return Math.max(1, Math.ceil((record.windowStart + windowMs - this.#now()) / 1000));
    }

    #failed(address: string): void {
        const record = this.#failures.get(address);
        const windowMs = this.#opts.loginWindowSec * 1000;
        if (record === undefined || record.windowStart + windowMs <= this.#now()) {
            this.#failures.set(address, { count: 1, windowStart: this.#now() });
            return;
        }
        record.count += 1;
    }

    #sweepCodes(): void {
        const now = this.#now();
        for (const [code, issued] of this.#codes) if (issued.expiresAt <= now) this.#codes.delete(code);
    }

    // ── token ───────────────────────────────────────────────────────────────────────────────────

    async #form(req: IncomingMessage): Promise<URLSearchParams> {
        if (req.method !== "POST") throw new OAuthError("invalid_request", "Use POST.", 405);
        if (!isForm(req)) throw new OAuthError("invalid_request", "POST an application/x-www-form-urlencoded body.");
        return new URLSearchParams(await readBody(req));
    }

    // RFC 6749 §2.3.1 — client_secret_basic or client_secret_post; a public client by its id alone.
    #authenticateClient(req: IncomingMessage, form: URLSearchParams): Client {
        const header = req.headers.authorization;
        let id: string | null = null;
        let secret: string | null = null;
        if (header !== undefined && /^Basic\s/iu.test(header)) {
            const decoded = Buffer.from(header.replace(/^Basic\s+/iu, ""), "base64").toString("utf8");
            const colon = decoded.indexOf(":");
            if (colon < 0) throw new OAuthError("invalid_client", "The Basic credentials are malformed.", 401);
            try {
                id = decodeURIComponent(decoded.slice(0, colon));
                secret = decodeURIComponent(decoded.slice(colon + 1));
            } catch { throw new OAuthError("invalid_client", "The Basic credentials are malformed.", 401); }
            if (form.has("client_secret")) throw new OAuthError("invalid_request", "Authenticate by one method only.");
        } else {
            id = form.get("client_id");
            secret = form.get("client_secret");
        }
        if (id === null || id.length === 0) throw new OAuthError("invalid_client", "The client did not identify itself.", 401);
        const client = this.#client(id, req);
        const address = req.socket.remoteAddress ?? "unknown";
        if (client === undefined) {
            this.#failed(address);
            throw new OAuthError("invalid_client", "The client is not registered with this daemon.", 401);
        }
        if (client.kind === "public") {
            if (secret !== null && secret.length > 0) throw new OAuthError("invalid_client", "A public client presents no secret.", 401);
            return client;
        }
        const retryAfter = this.#limited(address);
        if (retryAfter !== null) throw new OAuthError("invalid_client", `Too many failed attempts; retry in ${retryAfter} seconds.`, 429);
        const matches = secret !== null && (client.kind === "module"
            ? this.#credentials.authenticateClient(client.id, secret)
            : same(secret, client.secret ?? ""));
        if (!matches) {
            this.#failed(address);
            throw new OAuthError("invalid_client", "The client secret is wrong.", 401);
        }
        this.#failures.delete(address);
        return client;
    }

    async #token(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const form = await this.#form(req);
        const client = this.#authenticateClient(req, form);
        const grant = form.get("grant_type");
        let issued: { readonly claims: Omit<CredentialClaims, "expiresAt" | "kind">; readonly refresh: boolean };
        if (grant === "authorization_code") {
            const code = this.#codes.get(form.get("code") ?? "");
            this.#codes.delete(form.get("code") ?? "");
            if (code === undefined || code.expiresAt <= this.#now()) {
                throw new OAuthError("invalid_grant", "The authorization code is unknown, used or expired.");
            }
            if (code.clientId !== client.id) {
                // RFC 6749 §4.1.2 — a code presented by another client ends everything it stood for.
                this.#credentials.revokeFamily(code.family);
                throw new OAuthError("invalid_grant", "The authorization code was issued to another client.");
            }
            const verifier = form.get("code_verifier") ?? "";
            if (!PKCE_VERIFIER.test(verifier) || !same(createHash("sha256").update(verifier).digest("base64url"), code.challenge)) {
                throw new OAuthError("invalid_grant", "The code_verifier does not match the code_challenge.");
            }
            if (form.get("redirect_uri") !== code.redirectUri) throw new OAuthError("invalid_grant", "The redirect_uri differs from the authorization request's.");
            issued = { claims: { subject: OPERATOR_SUBJECT, clientId: client.id, scopes: code.scopes, family: code.family }, refresh: true };
        } else if (grant === "refresh_token") {
            const presented = form.get("refresh_token") ?? "";
            // Read before consuming: a refused scope leaves the token usable; a reuse is told as such.
            const claims = this.#credentials.verify(presented);
            if (claims === null || claims.kind !== "refresh") {
                const outcome = this.#credentials.consume(presented);
                throw new OAuthError("invalid_grant", "reusedFamily" in outcome && outcome.reusedFamily !== null
                    ? "The refresh token was already used; its grant is revoked."
                    : "The refresh token is unknown, expired or revoked.");
            }
            if (claims.clientId !== client.id) {
                this.#credentials.revokeFamily(claims.family);
                throw new OAuthError("invalid_grant", "The refresh token was issued to another client.");
            }
            const requested = form.get("scope");
            const scopes = requested === null ? claims.scopes : this.#scopes(requested, { ...client, scopes: claims.scopes });
            if (scopes === null) throw new OAuthError("invalid_scope", "A refreshed scope is within the grant's.");
            if (!("claims" in this.#credentials.consume(presented))) throw new OAuthError("invalid_grant", "The refresh token is unknown, expired or revoked.");
            issued = { claims: { subject: claims.subject, clientId: client.id, scopes, family: claims.family }, refresh: true };
        } else if (grant === "client_credentials") {
            if (client.kind === "public") throw new OAuthError("unauthorized_client", "Only a confidential client may use client_credentials.");
            // {§agui-oauth-clients} — a module's client stands for the operator who authorized it, never for itself.
            if (client.kind === "module") throw new OAuthError("unauthorized_client", "A module's client obtains tokens through the operator's authorization.");
            const scopes = this.#scopes(form.get("scope"), client);
            if (scopes === null) throw new OAuthError("invalid_scope", `The scope must be from ${SCOPES.join(" ")} and within the client's.`);
            issued = { claims: { subject: client.id === OPERATOR_CLIENT ? OPERATOR_SUBJECT : client.id, clientId: client.id, scopes, family: randomUUID() }, refresh: false };
        } else {
            throw new OAuthError("unsupported_grant_type", "The grant type is not authorization_code, refresh_token or client_credentials.");
        }
        const resource = form.get("resource");
        if (resource !== null && resource !== this.resource(req)) throw new OAuthError("invalid_target", `The resource must be ${this.resource(req)}.`);
        const access = this.#credentials.issue({ kind: "access", ...issued.claims, ttlMs: this.#opts.accessTtlSec * 1000 });
        const body: Record<string, unknown> = {
            access_token: access.token,
            token_type: "Bearer",
            expires_in: this.#opts.accessTtlSec,
            scope: issued.claims.scopes.join(" "),
        };
        if (issued.refresh) {
            body.refresh_token = this.#credentials.issue({ kind: "refresh", ...issued.claims, ttlMs: this.#opts.refreshTtlSec * 1000 }).token;
        }
        this.#json(res, 200, body);
    }

    // ── revocation (RFC 7009) ───────────────────────────────────────────────────────────────────

    async #revoke(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const form = await this.#form(req);
        const client = this.#authenticateClient(req, form);
        const token = form.get("token");
        if (token === null) throw new OAuthError("invalid_request", "A token is required.");
        const claims = this.#credentials.verify(token);
        // §2.2 — a token that is not the client's, or not live, revokes nothing and still answers 200.
        if (claims !== null && claims.clientId === client.id) this.#credentials.revokeFamily(claims.family);
        res.writeHead(200, { "cache-control": "no-store" });
        res.end();
    }

    // ── registration (RFC 7591) ─────────────────────────────────────────────────────────────────

    async #register(req: IncomingMessage, res: ServerResponse): Promise<void> {
        if (req.method !== "POST") throw new OAuthError("invalid_request", "Use POST.", 405);
        if (!isJson(req)) throw new OAuthError("invalid_client_metadata", "POST an application/json body.");
        let metadata: Record<string, unknown>;
        try {
            const parsed: unknown = JSON.parse(await readBody(req));
            if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
            metadata = parsed as Record<string, unknown>;
        } catch { throw new OAuthError("invalid_client_metadata", "The body is not a JSON object."); }
        const redirectUris = metadata.redirect_uris;
        if (!Array.isArray(redirectUris) || redirectUris.length === 0 || redirectUris.some((uri) => absoluteHttpUrl(uri) === null)) {
            throw new OAuthError("invalid_redirect_uri", "redirect_uris must list absolute http(s) URLs without fragments.");
        }
        const method = metadata.token_endpoint_auth_method ?? "none";
        if (method !== "none") {
            throw new OAuthError("invalid_client_metadata", "Only public clients register here; a confidential client is declared in the operator's configuration.");
        }
        const grantTypes = metadata.grant_types ?? ["authorization_code", "refresh_token"];
        if (!Array.isArray(grantTypes) || grantTypes.some((type) => type !== "authorization_code" && type !== "refresh_token")) {
            throw new OAuthError("invalid_client_metadata", "grant_types may name authorization_code and refresh_token.");
        }
        const responseTypes = metadata.response_types ?? ["code"];
        if (!Array.isArray(responseTypes) || responseTypes.some((type) => type !== "code")) {
            throw new OAuthError("invalid_client_metadata", "response_types may name code.");
        }
        const scopes = typeof metadata.scope === "string" ? this.#scopes(metadata.scope, { id: "", kind: "public", secret: null, stylesheet: null, scopes: SCOPES, redirectUris: [], name: null }) : SCOPES;
        if (scopes === null) throw new OAuthError("invalid_client_metadata", `scope must be from ${SCOPES.join(" ")}.`);
        const name = typeof metadata.client_name === "string" && metadata.client_name.length > 0 ? metadata.client_name : null;
        if (this.#registered >= MAX_REGISTERED_CLIENTS) throw new OAuthError("invalid_client_metadata", "This daemon holds no more registrations.", 503);
        const id = mint();
        this.#registered += 1;
        this.#clients.set(id, { id, kind: "public", secret: null, stylesheet: null, scopes, redirectUris: Object.freeze(redirectUris as string[]), name });
        this.#json(res, 201, {
            client_id: id,
            client_id_issued_at: Math.floor(this.#now() / 1000),
            redirect_uris: redirectUris,
            token_endpoint_auth_method: "none",
            grant_types: grantTypes,
            response_types: responseTypes,
            scope: scopes.join(" "),
            ...(name === null ? {} : { client_name: name }),
        });
    }
}
