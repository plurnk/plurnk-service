import { randomBytes } from "node:crypto";
import type { CredentialAuthority, CredentialClaims, IssuedCredential } from "@plurnk/plurnk-contracts";

// {§credential-authority} — the daemon's one authority over the credentials presented to its
// listener. Tokens are opaque random strings held in memory, so a restart revokes every one of
// them; revocation is by family, so an access token and the refresh token that renews it fall
// together. No HTTP lives here: the client protocol is the issuing face.
export default class Credentials implements CredentialAuthority {
    readonly #live = new Map<string, CredentialClaims>();
    // A refresh token retired by rotation stays known until it would have expired, so a second
    // presentation is recognized as reuse and ends its family ({§agui-oauth-tokens}).
    readonly #retired = new Map<string, { readonly family: string; readonly expiresAt: number }>();
    readonly #listeners = new Set<(family: string) => void>();
    readonly #now: () => number;

    constructor({ now = Date.now }: { readonly now?: () => number } = {}) {
        this.#now = now;
    }

    issue({ ttlMs, ...claims }: Omit<CredentialClaims, "expiresAt"> & { readonly ttlMs: number }): IssuedCredential {
        if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new TypeError("a credential needs a positive lifetime");
        if (claims.subject.length === 0 || claims.clientId.length === 0 || claims.family.length === 0) {
            throw new TypeError("a credential names its subject, its client and its family");
        }
        this.#sweep();
        const token = randomBytes(32).toString("base64url");
        const expiresAt = this.#now() + ttlMs;
        this.#live.set(token, { ...claims, scopes: Object.freeze([...claims.scopes]), expiresAt });
        return { token, expiresAt };
    }

    verify(token: string): CredentialClaims | null {
        const claims = this.#live.get(token);
        if (claims === undefined) return null;
        if (claims.expiresAt <= this.#now()) {
            this.#live.delete(token);
            return null;
        }
        return claims;
    }

    consume(token: string): { readonly claims: CredentialClaims } | { readonly reusedFamily: string | null } {
        const claims = this.verify(token);
        if (claims !== null) {
            if (claims.kind !== "refresh") return { reusedFamily: null };
            this.#live.delete(token);
            this.#retired.set(token, { family: claims.family, expiresAt: claims.expiresAt });
            return { claims };
        }
        const retired = this.#retired.get(token);
        if (retired === undefined || retired.expiresAt <= this.#now()) return { reusedFamily: null };
        this.revokeFamily(retired.family);
        return { reusedFamily: retired.family };
    }

    revokeFamily(family: string): void {
        for (const [token, claims] of this.#live) if (claims.family === family) this.#live.delete(token);
        for (const [token, retired] of this.#retired) if (retired.family === family) this.#retired.delete(token);
        for (const listener of this.#listeners) listener(family);
    }

    onRevoked(listener: (family: string) => void): () => void {
        this.#listeners.add(listener);
        return () => { this.#listeners.delete(listener); };
    }

    #sweep(): void {
        const now = this.#now();
        for (const [token, claims] of this.#live) if (claims.expiresAt <= now) this.#live.delete(token);
        for (const [token, retired] of this.#retired) if (retired.expiresAt <= now) this.#retired.delete(token);
    }
}
