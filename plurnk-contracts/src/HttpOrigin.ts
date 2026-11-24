import type { CredentialAuthority } from "./Application.ts";
import Problems from "./Problems.ts";
import type { ProblemDetails } from "./types.generated.ts";

/**
 * {§http-host} {§http-admission} A request as far as its headers (and optional socket endpoint),
 * keeping the package root runtime-neutral ({§whitespace-contract}).
 */
export interface RequestHeaders {
    readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
    readonly socket?: {
        readonly remoteAddress?: string | undefined;
        readonly localAddress?: string | undefined;
    };
}

const firstHeader = (raw: string | readonly string[] | undefined): string | undefined =>
    typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] : undefined;

/**
 * {§http-admission} Recognizes IPv4/IPv6 loopback hostnames and IPv4-mapped IPv6 loopback addresses.
 */
export const isLoopbackHost = (hostname: string | undefined): boolean => {
    if (typeof hostname !== "string" || hostname.length === 0) return false;
    const lower = hostname.toLowerCase();
    return (
        lower === "127.0.0.1"
        || lower === "localhost"
        || lower === "::1"
        || lower === "[::1]"
        || lower === "::ffff:127.0.0.1"
        || lower === "[::ffff:127.0.0.1]"
    );
};

const isWildcardBindHost = (host: string): boolean =>
    host === "0.0.0.0" || host === "::" || host === "[::]";

const formatHostPort = (host: string, port: number): string =>
    `${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${port}`;

/**
 * {§http-host} The origin a request reached this daemon at: the address its `Host` names,
 * over http, or the listener's own for a request that names none.
 */
export const requestOrigin = (req: RequestHeaders, listener: { readonly host: string; readonly port: number }): string => {
    const named = firstHeader(req.headers.host);
    if (named !== undefined && named.length > 0) {
        try { return `http://${new URL(`http://${named}`).host}`; } catch { /* a Host that is no address names nothing */ }
    }
    return `http://${formatHostPort(listener.host, listener.port)}`;
};

/**
 * {§http-admission} {§http-host} Resolves the daemon's public HTTP(S) origin for a request:
 * 1. Honors an explicit public issuer configured on `CredentialAuthority` (`https://` or static custom origin).
 * 2. Honors `X-Forwarded-Proto` / `X-Forwarded-Host` when delivered over a loopback reverse proxy.
 * 3. Falls back to the request `Host` header or normalized listener address (`0.0.0.0` / `::` -> `127.0.0.1`).
 */
export const resolvePublicOrigin = (
    req: RequestHeaders | undefined,
    listener: { readonly host: string; readonly port: number },
    credentials?: CredentialAuthority | null,
): string => {
    const rawHost = typeof listener.host === "string" ? listener.host : "";
    const hasPort = typeof listener.port === "number";
    const rawListenerOrigin = rawHost.length > 0 && hasPort ? `http://${formatHostPort(rawHost, listener.port)}` : "";
    const defaultHost = rawHost.length === 0 ? "" : isWildcardBindHost(rawHost) ? "127.0.0.1" : rawHost;
    const defaultListenerOrigin = defaultHost.length > 0 && hasPort ? `http://${formatHostPort(defaultHost, listener.port)}` : "";

    const face = credentials?.face() ?? null;
    if (face !== null) {
        const unconfigured = face.issuer().trim();
        const candidate = (req !== undefined ? face.issuer(req) : unconfigured).trim();
        if (candidate.length > 0) {
            try {
                const parsed = new URL(candidate);
                const isExplicitStaticIssuer =
                    unconfigured.length > 0
                    && unconfigured === candidate
                    && unconfigured !== rawListenerOrigin
                    && unconfigured !== defaultListenerOrigin;
                if (
                    (parsed.protocol === "https:" || parsed.protocol === "http:")
                    && (parsed.protocol === "https:" || isExplicitStaticIssuer)
                ) {
                    return parsed.origin;
                }
            } catch {
                // Fall back to request/listener resolution when configured issuer is malformed.
            }
        }
    }

    const remoteAddress = req?.socket?.remoteAddress;
    const localAddress = req?.socket?.localAddress;
    const onLoopbackSocket =
        (remoteAddress === undefined ? isLoopbackHost(rawHost) : isLoopbackHost(remoteAddress))
        && (isLoopbackHost(rawHost) || (isWildcardBindHost(rawHost) && isLoopbackHost(localAddress)));

    const forwardedProto = firstHeader(req?.headers["x-forwarded-proto"])?.split(",", 1)[0]?.trim().toLowerCase();
    const scheme =
        onLoopbackSocket && (forwardedProto === "https" || forwardedProto === "http")
            ? forwardedProto
            : "http";
    const forwardedHost =
        onLoopbackSocket && (forwardedProto === "https" || forwardedProto === "http")
            ? firstHeader(req?.headers["x-forwarded-host"])?.split(",", 1)[0]?.trim()
            : undefined;
    const rawHeader =
        forwardedHost !== undefined && forwardedHost.length > 0
            ? forwardedHost
            : firstHeader(req?.headers.host)?.trim() ?? "";

    if (rawHeader.length > 0) {
        try {
            const parsed = new URL(`${scheme}://${rawHeader}`);
            if (
                parsed.username === ""
                && parsed.password === ""
                && parsed.pathname === "/"
                && parsed.search === ""
                && parsed.hash === ""
                && !isWildcardBindHost(parsed.hostname)
            ) {
                if (
                    scheme === "https"
                    || parsed.port.length > 0
                    || rawHeader.endsWith(":80")
                    || !hasPort
                ) {
                    return parsed.origin;
                }
                return `http://${formatHostPort(parsed.hostname, listener.port)}`;
            }
        } catch {
            // Fall back to listener address when Host header is malformed.
        }
    }

    if (defaultListenerOrigin.length > 0) {
        return scheme === "https" && defaultHost.length > 0 && hasPort
            ? `https://${formatHostPort(defaultHost, listener.port)}`
            : defaultListenerOrigin;
    }
    return "";
};

export interface CorsHeaderOptions {
    readonly methods: string;
    readonly allowHeaders: string;
    readonly exposeHeaders?: string;
    readonly requestHeaders?: string | readonly string[] | undefined;
}

/**
 * {§http-admission} Builds lowercase CORS response headers when `allowOrigin` is non-empty;
 * returns an empty object under the same-origin default (`allowOrigin === ""`).
 */
export const buildCorsHeaders = (
    allowOrigin: string,
    options: CorsHeaderOptions,
): Record<string, string> => {
    const origin = allowOrigin.trim();
    if (origin.length === 0) return {};
    const requested = firstHeader(options.requestHeaders)?.trim();
    const allowHeaders =
        requested !== undefined && requested.length > 0 && options.allowHeaders === "*"
            ? requested
            : options.allowHeaders;
    return {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": options.methods,
        "access-control-allow-headers": allowHeaders,
        ...(options.exposeHeaders !== undefined && options.exposeHeaders.length > 0
            ? { "access-control-expose-headers": options.exposeHeaders }
            : {}),
    };
};

export interface ScopedRouteOptions {
    readonly mount: string;
    readonly domain: string;
    readonly codePrefix?: string;
    readonly notFoundDetail?: string;
    readonly malformedEncodingDetail?: string;
    readonly emptySegmentDetail?: string;
}

export type ScopedRouteParseResult =
    | { readonly ok: true; readonly workspaceSegment?: string; readonly sessionSegment?: string }
    | { readonly ok: false; readonly problem: ProblemDetails };

/**
 * {§http-admission} Parses `/<mount>[/<workspace>[/<session>]]` pathnames with URI-component decoding
 * and RFC 9457 Problem refusals on out-of-scope routes (`404`) or malformed percent-encoding (`400`).
 */
export const parseScopedRoute = (
    pathname: string,
    options: ScopedRouteOptions,
): ScopedRouteParseResult => {
    const mount = options.mount.endsWith("/") && options.mount.length > 1
        ? options.mount.slice(0, -1)
        : options.mount;
    const problem = (slug: string, status: number, detail: string, extra: Readonly<Record<string, unknown>> = {}): ProblemDetails =>
        Problems.create(options.domain, slug, status, detail, {
            ...(options.codePrefix === undefined ? {} : { code: `${options.codePrefix}/${slug}` }),
            path: pathname,
            stage: "routing",
            retryable: false,
            ...extra,
        });

    if (pathname === mount || pathname === `${mount}/`) {
        return { ok: true };
    }
    const prefix = `${mount}/`;
    if (!pathname.startsWith(prefix)) {
        return {
            ok: false,
            problem: problem("route-not-found", 404, options.notFoundDetail ?? "The requested HTTP route does not exist."),
        };
    }
    const trimmed = pathname.endsWith("/") ? pathname.slice(prefix.length, -1) : pathname.slice(prefix.length);
    const rawParts = trimmed.split("/");
    if (rawParts.length > 2 || rawParts.some((part) => part.length === 0)) {
        return {
            ok: false,
            problem: problem("route-not-found", 404, options.notFoundDetail ?? "The requested HTTP route does not exist.", {
                recovery: `Use \`${mount}\`, \`${mount}/<workspace>\`, or \`${mount}/<workspace>/<session>\`.`,
            }),
        };
    }
    try {
        const decoded = rawParts.map((part) => decodeURIComponent(part));
        if (options.emptySegmentDetail !== undefined && decoded.some((part) => part.trim().length === 0)) {
            return {
                ok: false,
                problem: problem("request-target-invalid", 400, options.emptySegmentDetail),
            };
        }
        return {
            ok: true,
            workspaceSegment: decoded[0],
            sessionSegment: decoded[1],
        };
    } catch {
        return {
            ok: false,
            problem: problem(
                "request-target-invalid",
                400,
                options.malformedEncodingDetail ?? `The ${mount} route contains malformed percent-encoding.`,
            ),
        };
    }
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
 * {§http-host} {§http-admission} Enforces browser same-origin CSRF / Cross-Site WebSocket Hijacking protection
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

    if (isLoopbackHost(options.listener.host) && !hasForwarded && rawHostHeader.length > 0) {
        try {
            const parsedHost = new URL(`http://${rawHostHeader}`);
            if (!isLoopbackHost(parsedHost.hostname)) {
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
 * {§credential-authority} {§http-host} {§http-admission} Verifies an HTTP/WebSocket request against the daemon's
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
