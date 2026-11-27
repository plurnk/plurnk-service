import {
    isRecord,
    sanitizeActorDisplayName,
    sanitizeActorHandle,
    type VerifiedBearerClaims,
} from "@plurnk/plurnk-contracts";
import { createRemoteJWKSet, customFetch, jwtVerify, type RemoteJWKSet } from "jose";
import { isLoopbackHost } from "./config.ts";

export interface OidcVerifierOptions {
    readonly issuer: string;
    readonly audience: string;
    readonly allowedUsers: readonly string[];
    readonly delegates?: readonly string[];
    readonly fetch?: typeof globalThis.fetch;
}

const stripTrailingSlashes = (value: string): string => value.replace(/\/+$/u, "");

const discoveryUrls = (issuer: string): readonly string[] => {
    const parsed = new URL(issuer);
    const base = stripTrailingSlashes(issuer);
    const pathname = stripTrailingSlashes(parsed.pathname);
    const rfc8414 = `${parsed.origin}/.well-known/oauth-authorization-server${pathname}`;
    const candidates = [
        `${base}/.well-known/openid-configuration`,
        rfc8414,
        ...(pathname.length > 0 ? [`${base}/.well-known/oauth-authorization-server`] : []),
    ];
    return [...new Set(candidates)];
};

const isAllowedJwksUrl = (jwksUri: string, issuerUrl: URL): boolean => {
    let parsed: URL;
    try {
        parsed = new URL(jwksUri);
    } catch {
        return false;
    }
    if (parsed.username.length > 0 || parsed.password.length > 0 || parsed.hash.length > 0) return false;
    if (parsed.protocol === "https:") return true;
    return parsed.protocol === "http:" && issuerUrl.protocol === "http:" && isLoopbackHost(parsed.hostname);
};

// {§auth-oauth} — discovers remote JWKS from OIDC / RFC 8414 metadata and verifies bearer JWTs via `jose`.
export default class OidcVerifier {
    readonly #issuer: string;
    readonly #issuerNormalized: string;
    readonly #audience: string;
    readonly #allowedSubs: ReadonlySet<string>;
    readonly #allowedEmails: ReadonlySet<string>;
    readonly #delegates: ReadonlySet<string>;
    readonly #fetch: typeof globalThis.fetch;
    #jwksPromise: Promise<RemoteJWKSet> | null = null;

    constructor(options: OidcVerifierOptions) {
        this.#issuer = options.issuer;
        this.#issuerNormalized = stripTrailingSlashes(options.issuer);
        this.#audience = options.audience;
        this.#allowedSubs = new Set(options.allowedUsers);
        this.#allowedEmails = new Set(options.allowedUsers.map((u) => u.toLowerCase()));
        this.#delegates = new Set(options.delegates ?? []);
        this.#fetch = options.fetch ?? globalThis.fetch;
    }

    async #discoverJwks(): Promise<RemoteJWKSet> {
        const issuerUrl = new URL(this.#issuer);
        for (const metadataUrl of discoveryUrls(this.#issuer)) {
            let response: Response;
            try {
                response = await this.#fetch(metadataUrl, {
                    method: "GET",
                    headers: { accept: "application/json" },
                    redirect: "manual",
                });
            } catch {
                continue;
            }
            if (!response.ok) continue;
            let doc: unknown;
            try {
                doc = await response.json();
            } catch {
                continue;
            }
            if (!isRecord(doc)) continue;
            if (typeof doc.issuer !== "string" || stripTrailingSlashes(doc.issuer) !== this.#issuerNormalized) {
                continue;
            }
            if (typeof doc.jwks_uri !== "string" || !isAllowedJwksUrl(doc.jwks_uri, issuerUrl)) {
                continue;
            }
            const jwksUrl = new URL(doc.jwks_uri);
            return createRemoteJWKSet(jwksUrl, {
                [customFetch]: (url, init) => this.#fetch(url, init),
            });
        }
        throw new Error(`OIDC discovery failed to resolve a valid jwks_uri for issuer ${this.#issuer}.`);
    }

    #jwks(): Promise<RemoteJWKSet> {
        if (this.#jwksPromise === null) {
            const pending = this.#discoverJwks().catch((error: unknown) => {
                if (this.#jwksPromise === pending) this.#jwksPromise = null;
                throw error;
            });
            this.#jwksPromise = pending;
        }
        return this.#jwksPromise;
    }

    async verify(token: string): Promise<VerifiedBearerClaims | null> {
        const trimmed = token.trim();
        if (trimmed.length === 0) return null;
        let payload: Awaited<ReturnType<typeof jwtVerify>>["payload"];
        try {
            const jwks = await this.#jwks();
            const issuerVariants = this.#issuer === this.#issuerNormalized
                ? [this.#issuer, `${this.#issuer}/`]
                : [this.#issuer, this.#issuerNormalized];
            ({ payload } = await jwtVerify(trimmed, jwks, {
                issuer: issuerVariants,
                ...(this.#audience.length > 0 ? { audience: this.#audience } : {}),
                requiredClaims: ["sub", "exp"],
            }));
        } catch {
            return null;
        }

        const sub = typeof payload.sub === "string" ? payload.sub.trim() : "";
        if (sub.length === 0) return null;

        const email = typeof payload.email === "string" && payload.email.trim().length > 0
            ? payload.email.trim()
            : undefined;
        const emailVerified = payload.email_verified === true;

        if (this.#allowedSubs.size > 0) {
            const subAdmitted = this.#allowedSubs.has(sub);
            const emailAdmitted = emailVerified && email !== undefined && this.#allowedEmails.has(email.toLowerCase());
            if (!subAdmitted && !emailAdmitted) return null;
        }

        const scopes = typeof payload.scope === "string"
            ? payload.scope.split(/\s+/u).filter((s) => s.length > 0)
            : Array.isArray(payload.scp)
                ? payload.scp.filter((s): s is string => typeof s === "string" && s.length > 0)
                : undefined;

        const name = typeof payload.name === "string" ? sanitizeActorDisplayName(payload.name) : undefined;
        const emailLocalPart =
            emailVerified && email !== undefined && email.includes("@")
                ? email.slice(0, email.indexOf("@"))
                : undefined;
        const handle =
            (typeof payload.preferred_username === "string"
                ? sanitizeActorHandle(payload.preferred_username)
                : undefined) ??
            (typeof payload.nickname === "string" ? sanitizeActorHandle(payload.nickname) : undefined) ??
            (name !== undefined ? sanitizeActorHandle(name, { lowercase: true }) : undefined) ??
            (emailLocalPart !== undefined ? sanitizeActorHandle(emailLocalPart, { lowercase: true }) : undefined);

        return {
            subject: sub,
            ...(handle !== undefined ? { handle } : {}),
            ...(name !== undefined ? { name } : {}),
            ...(email !== undefined ? { email } : {}),
            ...(scopes !== undefined ? { scopes } : {}),
            ...(typeof payload.exp === "number" ? { expiresAt: payload.exp * 1000 } : {}),
            ...(this.#delegates.has(sub) ? { canDelegateActor: true } : {}),
        };
    }
}
