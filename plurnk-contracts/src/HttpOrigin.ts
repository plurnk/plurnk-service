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

/**
 * {§http-host} The origin a request reached this daemon at: the address its `Host` names,
 * over http, or the listener's own for a request that names none.
 */
export const requestOrigin = (req: RequestHeaders, listener: { readonly host: string; readonly port: number }): string => {
    const named = req.headers.host;
    if (typeof named === "string" && named.length > 0) {
        try { return `http://${new URL(`http://${named}`).host}`; } catch { /* a Host that is no address names nothing */ }
    }
    return `http://${listener.host.includes(":") ? `[${listener.host}]` : listener.host}:${listener.port}`;
};

export interface BearerAdmissionOptions {
    readonly allowQueryToken?: boolean;
    readonly domain?: string;
    readonly codePrefix?: string;
    readonly requiredScope?: string;
    readonly acceptedScopes?: readonly string[];
}

export type BearerAdmission =
    | { readonly ok: true; readonly family: string | null; readonly subject: string | null }
    | { readonly ok: false; readonly problem: ProblemDetails; readonly challenge: string };

/**
 * {§credential-authority} {§http-host} Verifies an HTTP request against the daemon's
 * `CredentialAuthority` using `Authorization: Bearer <token>` (or `?access_token=<token>` when
 * `allowQueryToken` is set for SSE/WebSocket entry points), returning the admitted credential's
 * family/subject or an RFC 9457 Problem and RFC 6750 / RFC 9728 `WWW-Authenticate` challenge.
 */
export const admitBearerRequest = (
    credentials: CredentialAuthority,
    req: RequestHeaders & { readonly url?: string | undefined },
    options: BearerAdmissionOptions = {},
): BearerAdmission => {
    const face = credentials.face();
    const issuer = face?.issuer(req);
    if (face === null || issuer === undefined) {
        return { ok: true, family: null, subject: null };
    }

    const domain = options.domain ?? "daemon:http";
    const codePrefix = options.codePrefix;
    const problem = (slug: string, status: number, detail: string, fields: Readonly<Record<string, unknown>>): ProblemDetails =>
        Problems.create(domain, slug, status, detail, {
            ...(codePrefix === undefined ? {} : { code: `${codePrefix}/${slug}` }),
            ...fields,
        });

    const rawHeader = req.headers.authorization;
    const header = typeof rawHeader === "string" ? rawHeader : undefined;
    const challenge = (parameters: string): string =>
        `Bearer realm="plurnk"${parameters}, resource_metadata="${issuer}/.well-known/oauth-protected-resource"`;
    let presented = header === undefined ? null : /^Bearer(?:\s+(.*))?$/iu.exec(header);
    if (presented === null && options.allowQueryToken === true) {
        const url = new URL(req.url ?? "/", "http://listener");
        const queryToken = url.searchParams.get("access_token");
        if (queryToken !== null) presented = /^Bearer(?:\s+(.*))?$/iu.exec(`Bearer ${queryToken}`);
    }
    if (presented === null) {
        return {
            ok: false,
            challenge: challenge(""),
            problem: problem("bearer-token-required", 401, "The request did not provide a bearer token.", {
                stage: "authorization",
                recovery: "Present an access token issued by this daemon as `Authorization: Bearer <token>`.",
                retryable: false,
            }),
        };
    }
    const token = (presented[1] ?? "").trim();
    const claims = credentials.verify(token);
    if (claims === null || claims.kind !== "access") {
        return {
            ok: false,
            challenge: challenge(
                ', error="invalid_token", error_description="The access token is unknown, expired or revoked."',
            ),
            problem: problem("bearer-token-invalid", 401, "The access token is unknown, expired or revoked.", {
                stage: "authorization",
                recovery: "Obtain a new access token from this daemon's token endpoint.",
                retryable: false,
            }),
        };
    }
    const requiredScope = options.requiredScope ?? "acp";
    const acceptedScopes = options.acceptedScopes ?? [requiredScope];
    if (!acceptedScopes.some((scope) => claims.scopes.includes(scope))) {
        return {
            ok: false,
            challenge: challenge(`, error="insufficient_scope", scope="${requiredScope}"`),
            problem: problem(
                "bearer-scope-insufficient",
                403,
                `The access token does not carry the scope ${requiredScope}.`,
                {
                    stage: "authorization",
                    scope: requiredScope,
                    recovery: `Obtain an access token with the scope ${requiredScope}.`,
                    retryable: false,
                },
            ),
        };
    }
    return { ok: true, family: claims.family, subject: claims.subject };
};
