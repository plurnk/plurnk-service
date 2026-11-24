// {§client-oauth-pkce} Browser/Node-neutral OAuth 2.1 / OIDC discovery, Web Crypto PKCE S256,
// JWT expiry inspection, and per-origin single-flight token refresh deduplication.
import { isRecord } from "./guards.ts";
import { isLoopbackHost } from "./HttpOrigin.ts";

export interface ProtectedResourceMetadata {
    readonly resource: string;
    readonly authorizationServers: readonly string[];
    readonly scopesSupported?: readonly string[];
    readonly clientId?: string;
    readonly redirectUri?: string;
}

export interface AuthorizationServerMetadata {
    readonly issuer: string;
    readonly authorizationEndpoint: string;
    readonly tokenEndpoint: string;
    readonly registrationEndpoint?: string;
    readonly codeChallengeMethodsSupported?: readonly string[];
}

export interface PkcePair {
    readonly codeVerifier: string;
    readonly codeChallenge: string;
    readonly codeChallengeMethod: "S256";
}

const toBase64Url = (bytes: Uint8Array): string => {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
};

const fromBase64UrlToUtf8 = (segment: string): string | null => {
    try {
        const normalized = segment.replace(/-/gu, "+").replace(/_/gu, "/");
        const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
        const binary = atob(padded);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        return null;
    }
};

/**
 * {§client-oauth-pkce} Permits `https:` origins and loopback `http:` origins (`127.0.0.1`, `localhost`, `::1`).
 */
export const isAllowedOAuthUrl = (rawUrl: string): boolean => {
    try {
        const parsed = new URL(rawUrl);
        if (parsed.username.length > 0 || parsed.password.length > 0) return false;
        if (parsed.protocol === "https:") return true;
        return parsed.protocol === "http:" && isLoopbackHost(parsed.hostname);
    } catch {
        return false;
    }
};

/**
 * {§client-oauth-pkce} Extracts `resource_metadata="..."` from an RFC 9728 `WWW-Authenticate: Bearer` header.
 */
export const parseWwwAuthenticateResourceMetadata = (header: string | null | undefined): string | null => {
    if (typeof header !== "string" || header.length === 0) return null;
    const match = /\bresource_metadata="([^"]+)"/iu.exec(header);
    const candidate = match?.[1]?.trim() ?? "";
    return candidate.length > 0 && isAllowedOAuthUrl(candidate) ? candidate : null;
};

/**
 * {§client-oauth-pkce} Builds RFC 8414 §3 path-aware OAuth 2.0 Authorization Server Metadata and
 * OpenID Connect Discovery candidate URLs in priority order.
 */
export const buildAuthorizationServerMetadataUrls = (issuerUrl: string): readonly string[] => {
    const parsed = new URL(issuerUrl);
    if (!isAllowedOAuthUrl(parsed.href)) {
        throw new Error(`Authorization server issuer '${issuerUrl}' must use https:// or loopback http://.`);
    }
    const cleanPath = parsed.pathname.replace(/\/+$/u, "");
    const oauthUrl =
        cleanPath.length === 0
            ? `${parsed.origin}/.well-known/oauth-authorization-server`
            : `${parsed.origin}/.well-known/oauth-authorization-server${cleanPath}`;
    const oidcUrl =
        cleanPath.length === 0
            ? `${parsed.origin}/.well-known/openid-configuration`
            : `${parsed.origin}${cleanPath}/.well-known/openid-configuration`;
    return oauthUrl === oidcUrl ? [oauthUrl] : [oauthUrl, oidcUrl];
};

/**
 * {§client-oauth-pkce} Fetches and validates RFC 9728 Protected Resource Metadata.
 */
export const discoverProtectedResourceMetadata = async (
    originOrMetadataUrl: string,
    fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<ProtectedResourceMetadata> => {
    const parsed = new URL(originOrMetadataUrl);
    const metadataUrl = parsed.pathname.includes("/.well-known/")
        ? parsed.href
        : `${parsed.origin}/.well-known/oauth-protected-resource`;
    if (!isAllowedOAuthUrl(metadataUrl)) {
        throw new Error(`Protected resource metadata URL '${metadataUrl}' must use https:// or loopback http://.`);
    }
    const res = await fetchImpl(metadataUrl, { headers: { accept: "application/json" } });
    if (!res.ok) {
        throw new Error(`Protected resource metadata discovery failed with HTTP ${res.status}.`);
    }
    const body: unknown = await res.json();
    if (!isRecord(body) || typeof body.resource !== "string" || !Array.isArray(body.authorization_servers)) {
        throw new Error("Protected resource metadata is missing required 'resource' or 'authorization_servers'.");
    }
    const servers = body.authorization_servers.filter(
        (s): s is string => typeof s === "string" && isAllowedOAuthUrl(s),
    );
    if (servers.length === 0) {
        throw new Error("Protected resource metadata advertised no valid authorization_servers.");
    }
    const scopes = Array.isArray(body.scopes_supported)
        ? body.scopes_supported.filter((s): s is string => typeof s === "string" && s.length > 0)
        : undefined;
    return {
        resource: body.resource,
        authorizationServers: servers,
        ...(scopes === undefined ? {} : { scopesSupported: scopes }),
        ...(typeof body.client_id === "string" && body.client_id.length > 0 ? { clientId: body.client_id } : {}),
        ...(typeof body.redirect_uri === "string" && body.redirect_uri.length > 0 ? { redirectUri: body.redirect_uri } : {}),
    };
};

/**
 * {§client-oauth-pkce} Discovers and issuer-validates RFC 8414 / OIDC Authorization Server Metadata.
 */
export const discoverAuthorizationServerMetadata = async (
    issuerUrl: string,
    fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<AuthorizationServerMetadata> => {
    const urls = buildAuthorizationServerMetadataUrls(issuerUrl);
    const expectedIssuer = issuerUrl.replace(/\/+$/u, "");
    let lastError: Error | null = null;

    for (const url of urls) {
        try {
            const res = await fetchImpl(url, { headers: { accept: "application/json" } });
            if (!res.ok) {
                lastError = new Error(`Metadata endpoint '${url}' returned HTTP ${res.status}.`);
                continue;
            }
            const body: unknown = await res.json();
            if (
                !isRecord(body)
                || typeof body.issuer !== "string"
                || typeof body.authorization_endpoint !== "string"
                || typeof body.token_endpoint !== "string"
            ) {
                lastError = new Error(`Metadata at '${url}' is missing issuer, authorization_endpoint, or token_endpoint.`);
                continue;
            }
            if (body.issuer.replace(/\/+$/u, "") !== expectedIssuer) {
                throw new Error(`Authorization server issuer mismatch: expected '${issuerUrl}', got '${body.issuer}'.`);
            }
            if (!isAllowedOAuthUrl(body.authorization_endpoint) || !isAllowedOAuthUrl(body.token_endpoint)) {
                throw new Error("Authorization and token endpoints must use https:// or loopback http://.");
            }
            const methods = Array.isArray(body.code_challenge_methods_supported)
                ? body.code_challenge_methods_supported.filter((m): m is string => typeof m === "string")
                : undefined;
            if (methods !== undefined && methods.length > 0 && !methods.includes("S256")) {
                throw new Error("Authorization server does not support PKCE S256.");
            }
            return {
                issuer: body.issuer,
                authorizationEndpoint: body.authorization_endpoint,
                tokenEndpoint: body.token_endpoint,
                ...(typeof body.registration_endpoint === "string" && isAllowedOAuthUrl(body.registration_endpoint)
                    ? { registrationEndpoint: body.registration_endpoint }
                    : {}),
                ...(methods === undefined ? {} : { codeChallengeMethodsSupported: methods }),
            };
        } catch (cause) {
            const err = cause instanceof Error ? cause : new Error(String(cause));
            if (err.message.includes("issuer mismatch") || err.message.includes("PKCE S256") || err.message.includes("endpoints must use")) {
                throw err;
            }
            lastError = err;
        }
    }
    throw lastError ?? new Error(`Failed to discover authorization server metadata for '${issuerUrl}'.`);
};

/**
 * {§client-oauth-pkce} Generates an RFC 7636 S256 PKCE verifier and challenge using Web Crypto.
 */
export const generatePkcePair = async (): Promise<PkcePair> => {
    const random = new Uint8Array(32);
    globalThis.crypto.getRandomValues(random);
    const codeVerifier = toBase64Url(random);
    const digest = await globalThis.crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(codeVerifier),
    );
    return {
        codeVerifier,
        codeChallenge: toBase64Url(new Uint8Array(digest)),
        codeChallengeMethod: "S256",
    };
};

/**
 * {§client-oauth-pkce} Extracts the exact `exp` epoch-millisecond timestamp from a JWT access token,
 * or returns `null` for opaque tokens without fabricating a fallback TTL.
 */
export const parseJwtExpiresAt = (accessToken: string): number | null => {
    const parts = accessToken.split(".");
    if (parts.length !== 3 || parts[1].length === 0) return null;
    const json = fromBase64UrlToUtf8(parts[1]);
    if (json === null) return null;
    try {
        const payload: unknown = JSON.parse(json);
        if (!isRecord(payload) || typeof payload.exp !== "number" || !Number.isFinite(payload.exp) || payload.exp <= 0) {
            return null;
        }
        return Math.floor(payload.exp * 1000);
    } catch {
        return null;
    }
};

/**
 * {§client-oauth-pkce} Resolves token `expiresAt` in epoch ms from `expires_in` seconds (preserving
 * short-lived tokens `<= 10s` faithfully) or JWT `exp`, returning `undefined` when neither is present.
 */
export const resolveTokenExpiresAt = (
    expiresInSeconds: unknown,
    accessToken: string,
    nowMs = Date.now(),
): number | undefined => {
    if (typeof expiresInSeconds === "number" && Number.isFinite(expiresInSeconds) && expiresInSeconds > 0) {
        return nowMs + Math.floor(expiresInSeconds * 1000);
    }
    const jwtExp = parseJwtExpiresAt(accessToken);
    return jwtExp !== null ? jwtExp : undefined;
};

/**
 * {§client-oauth-pkce} Per-key single-flight coordinator so concurrent 401 retries share one
 * OAuth refresh-token exchange instead of racing and invalidating rotated grants.
 */
export class SingleFlightRefresh<T> {
    readonly #inFlight = new Map<string, Promise<T>>();

    run(key: string, operation: () => Promise<T>): Promise<T> {
        const existing = this.#inFlight.get(key);
        if (existing !== undefined) return existing;
        const promise = operation().finally(() => {
            if (this.#inFlight.get(key) === promise) {
                this.#inFlight.delete(key);
            }
        });
        this.#inFlight.set(key, promise);
        return promise;
    }

    has(key: string): boolean {
        return this.#inFlight.has(key);
    }
}
