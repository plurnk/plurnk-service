import type { CredentialAuthority } from "./Application.ts";
import Problems from "./Problems.ts";
import type { ProblemDetails } from "./types.generated.ts";

/**
 * {§http-host} A request as far as its headers, which is all an origin is read from. A Node request
 * satisfies it, and naming it keeps the package root runtime-neutral ({§whitespace-contract}).
 */
export interface RequestHeaders {
    readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
}

const firstHeader = (raw: string | readonly string[] | undefined): string | undefined =>
    typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] : undefined;

const isLoopbackHostname = (hostname: string): boolean => {
    const lower = hostname.toLowerCase();
    return lower === "127.0.0.1" || lower === "::1" || lower === "[::1]" || lower === "localhost";
};

/**
 * {§http-host} The origin a request reached this daemon at: the address its `Host` names,
 * over http, or the listener's own for a request that names none.
 */
export const requestOrigin = (req: RequestHeaders, listener: { readonly host: string; readonly port: number }): string => {
    const named = firstHeader(req.headers.host);
    if (named !== undefined && named.length > 0) {
        try { return `http://${new URL(`http://${named}`).host}`; } catch { /* a Host that is no address names nothing */ }
    }
    return `http://${listener.host.includes(":") && !listener.host.startsWith("[") ? `[${listener.host}]` : listener.host}:${listener.port}`;
};

export interface BrowserOriginOptions {
    readonly allowOrigin: string;
    readonly listener: { readonly host: string; readonly port: number };
    readonly domain?: string;
    readonly codePrefix?: string;
}

export type BrowserOriginAdmission =
    | { readonly ok: true }
    | { readonly ok: false; readonly problem: ProblemDetails };

/**
 * {§http-host} Enforces browser same-origin CSRF / Cross-Site WebSocket Hijacking protection
 * (`Sec-Fetch-Site` and `Origin` matching the target `Host`) when `allowOrigin` is empty, and
 * rejects browser DNS-rebinding `Host` headers on direct unproxied loopback listeners. Non-browser
 * clients (carrying neither `Origin` nor `Sec-Fetch-*`) pass through untouched.
 */
export const admitBrowserOrigin = (
    req: RequestHeaders,
    options: BrowserOriginOptions,
): BrowserOriginAdmission => {
    const domain = options.domain ?? "daemon:http";
    const codePrefix = options.codePrefix;
    const reject = (slug: string, detail: string): BrowserOriginAdmission => ({
        ok: false,
        problem: Problems.create(domain, slug, 403, detail, {
            ...(codePrefix === undefined ? {} : { code: `${codePrefix}/${slug}` }),
            stage: "authorization",
            retryable: false,
        }),
    });

    const allowOrigin = options.allowOrigin.trim();
    const rawOrigin = firstHeader(req.headers.origin)?.trim();
    const rawFetchSite = firstHeader(req.headers["sec-fetch-site"])?.trim().toLowerCase();
    const rawFetchMode = firstHeader(req.headers["sec-fetch-mode"])?.trim().toLowerCase();
    const isBrowserRequest = rawOrigin !== undefined || rawFetchSite !== undefined || rawFetchMode !== undefined;
    if (!isBrowserRequest) return { ok: true };

    if (allowOrigin === "*") return { ok: true };
    if (allowOrigin.length > 0) {
        if (rawOrigin !== undefined && rawOrigin !== allowOrigin) {
            return reject("cross-origin-forbidden", "The browser Origin header does not match the configured allowed origin.");
        }
        return { ok: true };
    }

    const hasForwarded =
        firstHeader(req.headers["x-forwarded-for"]) !== undefined ||
        firstHeader(req.headers["x-forwarded-proto"]) !== undefined ||
        firstHeader(req.headers["x-forwarded-host"]) !== undefined ||
        firstHeader(req.headers.forwarded) !== undefined;
    const rawHostHeader = (firstHeader(req.headers["x-forwarded-host"])?.split(",", 1)[0]?.trim() || firstHeader(req.headers.host)?.trim()) ?? "";

    if (isLoopbackHostname(options.listener.host) && !hasForwarded && rawHostHeader.length > 0) {
        try {
            const parsedHost = new URL(`http://${rawHostHeader}`);
            if (!isLoopbackHostname(parsedHost.hostname)) {
                return reject("host-not-allowed", "Browser requests to a loopback listener must target a loopback Host.");
            }
        } catch {
            return reject("host-not-allowed", "The request Host header is malformed.");
        }
    }

    if (rawFetchSite !== undefined && rawFetchSite !== "same-origin" && rawFetchSite !== "none") {
        return reject("cross-origin-forbidden", "Cross-origin browser requests are not permitted.");
    }

    if (rawOrigin !== undefined) {
        if (rawOrigin === "null" || rawHostHeader.length === 0) {
            return reject("cross-origin-forbidden", "The browser Origin header must match the target Host.");
        }
        try {
            const originUrl = new URL(rawOrigin);
            const expectedUrl = new URL(`${originUrl.protocol}//${rawHostHeader}`);
            if (originUrl.host.toLowerCase() !== expectedUrl.host.toLowerCase()) {
                return reject("cross-origin-forbidden", "The browser Origin header must match the target Host.");
            }
        } catch {
            return reject("cross-origin-forbidden", "The browser Origin header is malformed.");
        }
    }

    return { ok: true };
};

export interface BearerAdmissionOptions {
    readonly allowQueryToken?: boolean;
    readonly domain?: string;
    readonly codePrefix?: string;
}

export type BearerAdmission =
    | { readonly ok: true; readonly subject: string | null }
    | { readonly ok: false; readonly problem: ProblemDetails; readonly challenge: string };

const extractWsProtocolBearer = (rawProtocol: string | readonly string[] | undefined): string | null => {
    const joined = typeof rawProtocol === "string" ? rawProtocol : Array.isArray(rawProtocol) ? rawProtocol.join(",") : "";
    if (joined.length === 0) return null;
    for (const part of joined.split(",")) {
        const trimmed = part.trim();
        if (trimmed.startsWith("bearer.") && trimmed.length > "bearer.".length) {
            return trimmed.slice("bearer.".length);
        }
    }
    return null;
};

/**
 * {§credential-authority} {§http-host} Verifies an HTTP/WebSocket request against the daemon's
 * `CredentialAuthority` using `Authorization: Bearer <token>` (or `Sec-WebSocket-Protocol: bearer.<token>` /
 * `?access_token=<token>` when `allowQueryToken` is set), returning the admitted principal `subject`
 * or an RFC 9457 Problem and RFC 6750 / RFC 9728 `WWW-Authenticate` challenge.
 */
export const admitBearerRequest = async (
    credentials: CredentialAuthority,
    req: RequestHeaders & { readonly url?: string | undefined },
    options: BearerAdmissionOptions = {},
): Promise<BearerAdmission> => {
    const face = credentials.face();
    const resourceOrigin = face?.issuer(req);
    if (face === null || resourceOrigin === undefined) {
        return { ok: true, subject: null };
    }

    const domain = options.domain ?? "daemon:http";
    const codePrefix = options.codePrefix;
    const problem = (slug: string, status: number, detail: string, fields: Readonly<Record<string, unknown>>): ProblemDetails =>
        Problems.create(domain, slug, status, detail, {
            ...(codePrefix === undefined ? {} : { code: `${codePrefix}/${slug}` }),
            ...fields,
        });

    const header = firstHeader(req.headers.authorization);
    const challenge = (parameters: string): string =>
        `Bearer realm="plurnk"${parameters}, resource_metadata="${resourceOrigin}/.well-known/oauth-protected-resource"`;
    let token: string | null = null;
    if (header !== undefined) {
        const match = /^Bearer(?:\s+(.*))?$/iu.exec(header);
        if (match !== null) token = (match[1] ?? "").trim();
    }
    if (token === null && options.allowQueryToken === true) {
        token = extractWsProtocolBearer(req.headers["sec-websocket-protocol"]);
        if (token === null) {
            const url = new URL(req.url ?? "/", "http://listener");
            const queryToken = url.searchParams.get("access_token");
            if (queryToken !== null) token = queryToken.trim();
        }
    }
    if (token === null) {
        return {
            ok: false,
            challenge: challenge(""),
            problem: problem("bearer-token-required", 401, "The request did not provide a bearer token.", {
                stage: "authorization",
                recovery: "Present a valid OIDC bearer token as `Authorization: Bearer <token>`.",
                retryable: false,
            }),
        };
    }
    const claims = token.length === 0 ? null : await credentials.verify(token);
    if (claims === null) {
        return {
            ok: false,
            challenge: challenge(
                ', error="invalid_token", error_description="The bearer token is invalid, expired, or not authorized for this resource."',
            ),
            problem: problem("bearer-token-invalid", 401, "The bearer token is invalid, expired, or not authorized for this resource.", {
                stage: "authorization",
                recovery: "Obtain a valid access token from the authorization server advertised in `/.well-known/oauth-protected-resource`.",
                retryable: false,
            }),
        };
    }
    return { ok: true, subject: claims.subject };
};
