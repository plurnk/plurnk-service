import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { CredentialAuthority, CredentialClaims, CredentialFace, IssuedCredential, ModuleClient } from "@plurnk/plurnk-contracts";
import { Knob } from "@plurnk/plurnk-meta";

/** {§credential-authority} The daemon's posture, read once at boot from the shared panel. */
export interface CredentialPosture {
    /** `PLURNK_AUTH`: the daemon issues and requires credentials. */
    readonly authenticates: boolean;
    /** The operator's client secret while authenticating: `PLURNK_SECRET`, else minted for this boot. */
    readonly secret: string | null;
    /** The secret was minted here rather than configured, so the daemon writes it beside its database. */
    readonly minted: boolean;
}

// {§credential-authority} — the daemon's one authority over the credentials presented to its
// listener. Tokens are opaque random strings held in memory, so a restart revokes every one of
// them; revocation is by family, so an access token and the refresh token that renews it fall
// together. No HTTP lives here: the client protocol is the issuing face.
export default class Credentials implements CredentialAuthority {
    /** The file beside the database that holds a minted operator secret. */
    static readonly SECRET_FILE = "secret";

    readonly operatorSecret: string | null;
    readonly #live = new Map<string, CredentialClaims>();
    // A refresh token retired by rotation stays known until it would have expired, so a second
    // presentation is recognized as reuse and ends its family ({§agui-oauth-tokens}).
    readonly #retired = new Map<string, { readonly family: string; readonly expiresAt: number }>();
    readonly #listeners = new Set<(family: string) => void>();
    // {§credential-module-client} — the clients this daemon's own modules registered, each with the
    // secret minted for it at this boot.
    readonly #clients = new Map<string, { readonly client: ModuleClient; readonly secret: string }>();
    readonly #now: () => number;
    #face: CredentialFace | null = null;

    constructor({ now = Date.now, operatorSecret = null }: { readonly now?: () => number; readonly operatorSecret?: string | null } = {}) {
        this.#now = now;
        this.operatorSecret = operatorSecret;
    }

    // {§credential-authority} — the posture is `PLURNK_AUTH`, never an inference from what else is
    // set: on, the operator's secret is `PLURNK_SECRET` or one minted for this boot; off, no
    // credential exists.
    static posture(env: NodeJS.ProcessEnv = process.env): CredentialPosture {
        const authenticates = Knob.flag("PLURNK_AUTH", env);
        if (!authenticates) return { authenticates, secret: null, minted: false };
        const configured = env.PLURNK_SECRET;
        if (configured !== undefined && configured.length > 0) return { authenticates, secret: configured, minted: false };
        return { authenticates, secret: Credentials.mint(), minted: true };
    }

    static mint(): string {
        return randomBytes(32).toString("base64url");
    }

    static secretPath(dbPath: string): string {
        return join(dirname(dbPath), Credentials.SECRET_FILE);
    }

    /** Writes a minted secret where same-user clients read it: 0600, complete or absent, overwritten at every boot. */
    static async writeSecret(path: string, secret: string): Promise<void> {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const stage = join(dirname(path), `.${basename(path)}-${process.pid}`);
        await writeFile(stage, `${secret}\n`, { encoding: "utf8", mode: 0o600, flag: "w" });
        await rename(stage, path);
    }

    /** Removes the file a previous boot may have left: a configured secret or an open daemon leaves none. */
    static async removeSecret(path: string): Promise<void> {
        await rm(path, { force: true });
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

    registerClient({ id, redirectUris, scopes }: ModuleClient): { readonly clientId: string; readonly clientSecret: string } {
        if (typeof id !== "string" || !/^[A-Za-z0-9._-]+$/u.test(id) || id === "operator") {
            throw new TypeError(`a module client id is letters, digits, '.', '_' or '-', and never "operator"; got ${JSON.stringify(id)}`);
        }
        if (!Array.isArray(redirectUris) || redirectUris.length === 0 || !redirectUris.every(Credentials.#redirect)) {
            throw new TypeError(`the module client '${id}' needs redirectUris, absolute http(s) URLs without fragments`);
        }
        if (!Array.isArray(scopes) || scopes.length === 0 || !scopes.every((scope) => typeof scope === "string" && /^[\x21\x23-\x5B\x5D-\x7E]+$/u.test(scope))) {
            throw new TypeError(`the module client '${id}' needs scopes, a non-empty list of scope tokens`);
        }
        if (this.#clients.has(id)) throw new Error(`the credential authority already has a module client '${id}'`);
        const secret = Credentials.mint();
        this.#clients.set(id, {
            client: Object.freeze({ id, redirectUris: Object.freeze([...redirectUris]), scopes: Object.freeze([...new Set(scopes)]) }),
            secret,
        });
        return { clientId: id, clientSecret: secret };
    }

    client(id: string): ModuleClient | null {
        return this.#clients.get(id)?.client ?? null;
    }

    // Digests are compared, so neither the length nor a prefix of the secret is told by timing.
    authenticateClient(id: string, secret: string): boolean {
        const held = this.#clients.get(id);
        if (held === undefined) return false;
        const digest = (value: string): Buffer => createHash("sha256").update(value).digest();
        return timingSafeEqual(digest(secret), digest(held.secret));
    }

    static #redirect(value: unknown): boolean {
        if (typeof value !== "string") return false;
        try {
            const url = new URL(value);
            return (url.protocol === "http:" || url.protocol === "https:") && url.hash === "";
        } catch { return false; }
    }

    publish(face: CredentialFace): void {
        if (this.#face !== null) throw new Error("the credential authority already has an issuing face");
        this.#face = face;
    }

    face(): CredentialFace | null {
        return this.#face;
    }

    #sweep(): void {
        const now = this.#now();
        for (const [token, claims] of this.#live) if (claims.expiresAt <= now) this.#live.delete(token);
        for (const [token, retired] of this.#retired) if (retired.expiresAt <= now) this.#retired.delete(token);
    }
}
