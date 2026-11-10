import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
    isRecord,
    type CredentialAuthority,
    type CredentialClaims,
    type CredentialFace,
    type CredentialSession,
    type IssuedCredential,
    type ModuleClient,
    type PublicOAuthClient,
} from "@plurnk/plurnk-contracts";
import { Knob } from "@plurnk/plurnk-meta";

const ENVELOPE_MAGIC = Buffer.from("PLKCRED1", "ascii");
const HKDF_INFO = Buffer.from("plurnk-auth/grants/v1", "utf8");
const gcmIvLength = 12;
const gcmTagLength = 16;
const hkdfKeyLength = 32;

interface StoredGrantsEnvelope {
    readonly version: 1;
    readonly live: readonly [string, CredentialClaims][];
    readonly retired: readonly [string, { readonly family: string; readonly expiresAt: number }][];
    readonly established: readonly [string, number][];
    readonly publicClients: readonly PublicOAuthClient[];
}

/** {§credential-authority} The daemon's posture, read once at boot from the shared panel. */
export interface CredentialPosture {
    /** `PLURNK_AUTH`: the daemon issues and requires credentials. */
    readonly authenticates: boolean;
    /** The operator's client secret while authenticating: `PLURNK_SECRET`, else the durable host secret beside the database. */
    readonly secret: string | null;
    /** The secret is host-managed rather than configured via `PLURNK_SECRET`, so the daemon maintains it beside its database. */
    readonly minted: boolean;
}

// {§credential-authority} — the daemon's one authority over the credentials presented to its
// listener. Tokens are opaque random strings; non-module grants, retired refresh tokens and
// registered public clients persist encrypted (`0600`, AES-256-GCM under HKDF of `operatorSecret`)
// beside the database when `storePath` is supplied, so browser sessions and OAuth grants survive
// restarts while rotating the secret fails closed cleanly. Revocation is by family, so an access
// token and the refresh token that renews it fall together. No HTTP lives here: the client protocol
// is the issuing face.
export default class Credentials implements CredentialAuthority {
    /** The file beside the database that holds the host-managed operator secret. */
    static readonly SECRET_FILE = "secret";
    /** The file beside the database that holds AES-256-GCM encrypted OAuth grants and sessions. */
    static readonly GRANTS_FILE = "credentials";

    readonly operatorSecret: string | null;
    readonly #storePath: string | null;
    readonly #encryptionKey: Buffer | null;
    readonly #live = new Map<string, CredentialClaims>();
    // A refresh token retired by rotation stays known until it would have expired, so a second
    // presentation is recognized as reuse and ends its family ({§auth-oauth-tokens}).
    readonly #retired = new Map<string, { readonly family: string; readonly expiresAt: number }>();
    readonly #listeners = new Set<(family: string) => void>();
    // {§credential-authority} — when each family holding a live credential was first issued into.
    readonly #established = new Map<string, number>();
    // {§credential-authority} — the clients this daemon's own modules registered, each with the
    // secret minted for it at this boot.
    readonly #clients = new Map<string, { readonly client: ModuleClient; readonly secret: string }>();
    readonly #publicClients = new Map<string, PublicOAuthClient>();
    readonly #now: () => number;
    #face: CredentialFace | null = null;
    #writeSeq = 0;

    constructor({
        now = Date.now,
        operatorSecret = null,
        storePath = null,
    }: {
        readonly now?: () => number;
        readonly operatorSecret?: string | null;
        readonly storePath?: string | null;
    } = {}) {
        this.#now = now;
        this.operatorSecret = operatorSecret;
        this.#storePath = storePath !== null && operatorSecret !== null && operatorSecret.length > 0 ? storePath : null;
        this.#encryptionKey = this.#storePath === null || operatorSecret === null
            ? null
            : Buffer.from(hkdfSync("sha256", Buffer.from(operatorSecret, "utf8"), Buffer.alloc(0), HKDF_INFO, hkdfKeyLength));
        this.#load();
    }

    // {§credential-authority} — the posture is `PLURNK_AUTH`, never an inference from what else is
    // set: on, the operator's secret is `PLURNK_SECRET`, else an existing durable `secret` file beside
    // the database, else freshly minted; off, no credential exists.
    static posture(env: NodeJS.ProcessEnv = process.env, secretPath: string | null = null): CredentialPosture {
        const authenticates = Knob.flag("PLURNK_AUTH", env);
        if (!authenticates) return { authenticates, secret: null, minted: false };
        const configured = env.PLURNK_SECRET;
        if (configured !== undefined && configured.length > 0) return { authenticates, secret: configured, minted: false };
        const persisted = secretPath === null ? null : Credentials.readSecretSync(secretPath);
        return { authenticates, secret: persisted ?? Credentials.mint(), minted: true };
    }

    static mint(): string {
        return randomBytes(32).toString("base64url");
    }

    static secretPath(dbPath: string): string {
        return join(dirname(dbPath), Credentials.SECRET_FILE);
    }

    static grantsPath(dbPath: string): string {
        return join(dirname(dbPath), Credentials.GRANTS_FILE);
    }

    static readSecretSync(path: string): string | null {
        try {
            const trimmed = readFileSync(path, "utf8").trim();
            return trimmed.length > 0 && !/\s/u.test(trimmed) ? trimmed : null;
        } catch {
            return null;
        }
    }

    /** Writes a minted secret where same-user clients read it: 0600, complete or absent. */
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

    /** Removes the encrypted grant file when authentication is turned off (`PLURNK_AUTH=0`). */
    static async removeGrants(path: string): Promise<void> {
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
        if (!this.#established.has(claims.family)) this.#established.set(claims.family, this.#now());
        this.#live.set(token, { ...claims, scopes: Object.freeze([...claims.scopes]), expiresAt });
        if (!this.#clients.has(claims.clientId)) this.#save();
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
            if (!this.#clients.has(claims.clientId)) this.#save();
            return { claims };
        }
        const retired = this.#retired.get(token);
        if (retired === undefined || retired.expiresAt <= this.#now()) return { reusedFamily: null };
        this.revokeFamily(retired.family);
        return { reusedFamily: retired.family };
    }

    revokeFamily(family: string): void {
        let mutated = false;
        for (const [token, claims] of this.#live) {
            if (claims.family === family) {
                this.#live.delete(token);
                if (!this.#clients.has(claims.clientId)) mutated = true;
            }
        }
        for (const [token, retired] of this.#retired) {
            if (retired.family === family) {
                this.#retired.delete(token);
                mutated = true;
            }
        }
        if (this.#established.delete(family)) mutated = true;
        if (mutated) this.#save();
        for (const listener of this.#listeners) listener(family);
    }

    onRevoked(listener: (family: string) => void): () => void {
        this.#listeners.add(listener);
        return () => { this.#listeners.delete(listener); };
    }

    // {§credential-authority} — a browser sign-in is a family holding a live session credential. Its
    // family is its handle: nothing admits a family as a credential, and no token is told here.
    sessions(subject: string): readonly CredentialSession[] {
        const now = this.#now();
        const families = new Map<string, { expiresAt: number; signedIn: boolean; clients: Set<string> }>();
        for (const claims of this.#live.values()) {
            if (claims.subject !== subject || claims.expiresAt <= now) continue;
            const family = families.get(claims.family) ?? { expiresAt: 0, signedIn: false, clients: new Set<string>() };
            family.clients.add(claims.clientId);
            if (claims.kind === "session") {
                family.signedIn = true;
                family.expiresAt = Math.max(family.expiresAt, claims.expiresAt);
            }
            families.set(claims.family, family);
        }
        return Object.freeze([...families]
            .filter(([, family]) => family.signedIn)
            .map(([family, { expiresAt, clients }]) => Object.freeze({
                family, subject, createdAt: this.#established.get(family)!, expiresAt, clients: Object.freeze([...clients].toSorted()),
            }))
            .toSorted((a, b) => a.createdAt - b.createdAt || a.family.localeCompare(b.family)));
    }

    registerClient({ id, redirectPaths, scopes, stylesheetPath }: ModuleClient): { readonly clientId: string; readonly clientSecret: string } {
        if (typeof id !== "string" || !/^[A-Za-z0-9._-]+$/u.test(id) || id === "operator") {
            throw new TypeError(`a module client id is letters, digits, '.', '_' or '-', and never "operator"; got ${JSON.stringify(id)}`);
        }
        if (!Array.isArray(redirectPaths) || redirectPaths.length === 0 || !redirectPaths.every(Credentials.#pathname)) {
            throw new TypeError(`the module client '${id}' needs redirectPaths, absolute pathnames without a query or a fragment`);
        }
        if (!Array.isArray(scopes) || scopes.length === 0 || !scopes.every((scope) => typeof scope === "string" && /^[\x21\x23-\x5B\x5D-\x7E]+$/u.test(scope))) {
            throw new TypeError(`the module client '${id}' needs scopes, a non-empty list of scope tokens`);
        }
        if (stylesheetPath !== undefined && !Credentials.#pathname(stylesheetPath)) {
            throw new TypeError(`the module client '${id}' gave a stylesheetPath that is not an absolute pathname without a query or a fragment`);
        }
        if (this.#clients.has(id)) throw new Error(`the credential authority already has a module client '${id}'`);
        const secret = Credentials.mint();
        this.#clients.set(id, {
            client: Object.freeze({ id, redirectPaths: Object.freeze([...redirectPaths]), scopes: Object.freeze([...new Set(scopes)]), ...(stylesheetPath === undefined ? {} : { stylesheetPath }) }),
            secret,
        });
        let evicted = false;
        for (const [token, claims] of this.#live) {
            if (claims.clientId === id) {
                this.#live.delete(token);
                evicted = true;
            }
        }
        if (evicted) {
            this.#sweep();
            this.#save();
        }
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

    registerPublicClient(client: PublicOAuthClient): void {
        const normalized: PublicOAuthClient = Object.freeze({
            id: client.id,
            scopes: Object.freeze([...client.scopes]),
            redirectUris: Object.freeze([...client.redirectUris]),
            name: client.name,
        });
        this.#publicClients.set(client.id, normalized);
        this.#save();
    }

    publicClients(): readonly PublicOAuthClient[] {
        return Object.freeze([...this.#publicClients.values()]);
    }

    retainClients(allowedClientIds: ReadonlySet<string>): void {
        const revokedFamilies = new Set<string>();
        for (const claims of this.#live.values()) {
            if (!allowedClientIds.has(claims.clientId) && !this.#clients.has(claims.clientId)) {
                revokedFamilies.add(claims.family);
            }
        }
        for (const family of revokedFamilies) this.revokeFamily(family);
    }

    // {§credential-authority} — a pathname exactly as a URL carries it: one leading slash, nothing
    // a parser would rewrite, no query and no fragment, so `issuer + path` is the address itself.
    static #pathname(value: unknown): boolean {
        if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return false;
        try {
            const url = new URL(value, "http://issuer");
            return url.host === "issuer" && url.pathname === value && url.search === "" && url.hash === "";
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
        const held = new Set([...this.#live.values()].map(({ family }) => family));
        for (const family of this.#established.keys()) if (!held.has(family)) this.#established.delete(family);
    }

    #load(): void {
        if (this.#storePath === null || this.#encryptionKey === null) return;
        let raw: Buffer;
        try {
            raw = readFileSync(this.#storePath);
        } catch {
            return;
        }
        if (raw.length <= ENVELOPE_MAGIC.length + gcmIvLength + gcmTagLength) return;
        if (!raw.subarray(0, ENVELOPE_MAGIC.length).equals(ENVELOPE_MAGIC)) return;
        try {
            const ivOffset = ENVELOPE_MAGIC.length;
            const tagOffset = ivOffset + gcmIvLength;
            const cipherOffset = tagOffset + gcmTagLength;
            const decipher = createDecipheriv("aes-256-gcm", this.#encryptionKey, raw.subarray(ivOffset, tagOffset));
            decipher.setAAD(HKDF_INFO);
            decipher.setAuthTag(raw.subarray(tagOffset, cipherOffset));
            const plaintext = Buffer.concat([decipher.update(raw.subarray(cipherOffset)), decipher.final()]).toString("utf8");
            const parsed: unknown = JSON.parse(plaintext);
            if (!isRecord(parsed) || parsed.version !== 1) return;
            const now = this.#now();
            if (Array.isArray(parsed.established)) {
                for (const entry of parsed.established) {
                    if (Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "number" && Number.isFinite(entry[1])) {
                        this.#established.set(entry[0], entry[1]);
                    }
                }
            }
            if (Array.isArray(parsed.live)) {
                for (const entry of parsed.live) {
                    if (!Array.isArray(entry) || typeof entry[0] !== "string" || !isRecord(entry[1])) continue;
                    const [token, c] = entry;
                    if (
                        (c.kind === "access" || c.kind === "refresh" || c.kind === "session")
                        && typeof c.subject === "string" && c.subject.length > 0
                        && typeof c.clientId === "string" && c.clientId.length > 0
                        && Array.isArray(c.scopes) && c.scopes.every((s): s is string => typeof s === "string")
                        && typeof c.family === "string" && c.family.length > 0
                        && typeof c.expiresAt === "number" && c.expiresAt > now
                    ) {
                        if (!this.#established.has(c.family)) this.#established.set(c.family, now);
                        this.#live.set(token, {
                            kind: c.kind,
                            subject: c.subject,
                            clientId: c.clientId,
                            scopes: Object.freeze([...c.scopes]),
                            family: c.family,
                            expiresAt: c.expiresAt,
                        });
                    }
                }
            }
            if (Array.isArray(parsed.retired)) {
                for (const entry of parsed.retired) {
                    if (!Array.isArray(entry) || typeof entry[0] !== "string" || !isRecord(entry[1])) continue;
                    const [token, r] = entry;
                    if (typeof r.family === "string" && typeof r.expiresAt === "number" && r.expiresAt > now) {
                        this.#retired.set(token, { family: r.family, expiresAt: r.expiresAt });
                    }
                }
            }
            if (Array.isArray(parsed.publicClients)) {
                for (const c of parsed.publicClients) {
                    if (
                        isRecord(c)
                        && typeof c.id === "string" && c.id.length > 0
                        && Array.isArray(c.scopes) && c.scopes.every((s): s is string => typeof s === "string")
                        && Array.isArray(c.redirectUris) && c.redirectUris.every((u): u is string => typeof u === "string")
                        && (c.name === null || typeof c.name === "string")
                    ) {
                        this.#publicClients.set(c.id, Object.freeze({
                            id: c.id,
                            scopes: Object.freeze([...c.scopes]),
                            redirectUris: Object.freeze([...c.redirectUris]),
                            name: c.name,
                        }));
                    }
                }
            }
            this.#sweep();
        } catch {
            // Rotated secret or corrupted ciphertext fails closed to clean empty state.
            this.#live.clear();
            this.#retired.clear();
            this.#established.clear();
            this.#publicClients.clear();
        }
    }

    #save(): void {
        if (this.#storePath === null || this.#encryptionKey === null) return;
        this.#sweep();
        const live: [string, CredentialClaims][] = [];
        const persistedFamilies = new Set<string>();
        for (const [token, claims] of this.#live) {
            if (this.#clients.has(claims.clientId)) continue;
            live.push([token, claims]);
            persistedFamilies.add(claims.family);
        }
        const envelope: StoredGrantsEnvelope = {
            version: 1,
            live,
            retired: [...this.#retired.entries()],
            established: [...this.#established.entries()].filter(([family]) => persistedFamilies.has(family)),
            publicClients: [...this.#publicClients.values()],
        };
        const iv = randomBytes(gcmIvLength);
        const cipher = createCipheriv("aes-256-gcm", this.#encryptionKey, iv);
        cipher.setAAD(HKDF_INFO);
        const ciphertext = Buffer.concat([cipher.update(JSON.stringify(envelope), "utf8"), cipher.final()]);
        const tag = cipher.getAuthTag();
        const bytes = Buffer.concat([ENVELOPE_MAGIC, iv, tag, ciphertext]);
        mkdirSync(dirname(this.#storePath), { recursive: true, mode: 0o700 });
        const stage = join(dirname(this.#storePath), `.${basename(this.#storePath)}-${process.pid}-${++this.#writeSeq}`);
        writeFileSync(stage, bytes, { mode: 0o600, flag: "w" });
        renameSync(stage, this.#storePath);
    }
}
