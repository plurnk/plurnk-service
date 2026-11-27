import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isRecord, type McpServerDefinition } from "@plurnk/plurnk-contracts";
import { OWNER } from "./attachment.ts";
import { readDefinition } from "./definition.ts";
import type { GrantScope } from "./grantStore.ts";

const ENVELOPE_MAGIC = Buffer.from("PLKMCPS1", "ascii");
const HKDF_INFO = Buffer.from("plurnk-mcp/secrets/v1", "utf8");
const LOCAL_KEY_FILE = ".secrets-key";
const FILE_PREFIX = "secrets-";
const FILE_SUFFIX = ".enc";
const gcmIvLength = 12;
const gcmTagLength = 16;
const hkdfKeyLength = 32;

export const SECRET_KEY_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export const isReservedPlurnkKey = (name: string): boolean => /^PLURNK_/iu.test(name);

interface StoredMcpSecretsEnvelope {
    readonly version: 1;
    readonly alias: string;
    readonly secrets: Readonly<Record<string, string>>;
    readonly projectDefinition?: McpServerDefinition;
}

export interface StoredSecretEntry {
    readonly alias: string;
    readonly secrets: Readonly<Record<string, string>>;
    readonly projectDefinition?: McpServerDefinition;
}

export const computeSecretDigest = (secrets: Readonly<Record<string, string>>): string => {
    const entries = Object.entries(secrets).toSorted(([a], [b]) => a.localeCompare(b));
    if (entries.length === 0) return "";
    return createHash("sha256").update(JSON.stringify(entries), "utf8").digest("hex");
};

// {§mcp-secrets} Encrypted per-workspace and service-wide, per-alias MCP secret storage outside SQLite.
export default class SecretStore {
    readonly #stateDirectory: (workspaceId: number, owner: string) => Promise<string>;
    readonly #serviceStateDirectory: ((owner: string) => Promise<string>) | undefined;
    readonly #queues = new Map<string, Promise<void>>();
    #writeSeq = 0;

    constructor({
        stateDirectory,
        serviceStateDirectory,
    }: {
        readonly stateDirectory: (workspaceId: number, owner: string) => Promise<string>;
        readonly serviceStateDirectory?: (owner: string) => Promise<string>;
    }) {
        this.#stateDirectory = stateDirectory;
        this.#serviceStateDirectory = serviceStateDirectory;
    }

    static fileName(alias: string): string {
        return `${FILE_PREFIX}${encodeURIComponent(alias)}${FILE_SUFFIX}`;
    }

    #directory(scope: GrantScope): Promise<string> {
        if (scope === "service") {
            if (this.#serviceStateDirectory === undefined) {
                throw new Error("Service-scoped MCP secret storage is unavailable in this host.");
            }
            return this.#serviceStateDirectory(OWNER);
        }
        return this.#stateDirectory(scope, OWNER);
    }

    #queue<T>(scope: GrantScope, alias: string, work: () => Promise<T>): Promise<T> {
        const key = `${scope}:${alias}`;
        const previous = this.#queues.get(key) ?? Promise.resolve();
        const task = previous.catch(() => undefined).then(work);
        const tracked = task.then(() => undefined, () => undefined).finally(() => {
            if (this.#queues.get(key) === tracked) this.#queues.delete(key);
        });
        this.#queues.set(key, tracked);
        return task;
    }

    async flush(): Promise<void> {
        while (this.#queues.size > 0) {
            await Promise.allSettled([...this.#queues.values()]);
        }
    }

    async #deriveKey(stateDir: string, createLocalKey: boolean): Promise<Buffer | null> {
        const keyPath = join(stateDir, LOCAL_KEY_FILE);
        let master: Buffer;
        try {
            const existing = await readFile(keyPath);
            if (existing.length < hkdfKeyLength) throw new Error("invalid local key length");
            master = existing;
        } catch {
            if (!createLocalKey) return null;
            await mkdir(stateDir, { recursive: true, mode: 0o700 });
            master = randomBytes(hkdfKeyLength);
            const stage = join(stateDir, `.secrets-key-${process.pid}-${++this.#writeSeq}`);
            await writeFile(stage, master, { mode: 0o600, flag: "w" });
            await rename(stage, keyPath);
        }
        return Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), HKDF_INFO, hkdfKeyLength));
    }

    static #aad(scope: GrantScope, alias: string): Buffer {
        return Buffer.from(`plurnk-mcp/secrets/v1:${scope}:${alias}`, "utf8");
    }

    async #readUnlocked(scope: GrantScope, alias: string): Promise<StoredSecretEntry | undefined> {
        if (scope === "service" && this.#serviceStateDirectory === undefined) return undefined;
        const stateDir = await this.#directory(scope);
        const path = join(stateDir, SecretStore.fileName(alias));
        let raw: Buffer;
        try {
            raw = await readFile(path);
        } catch {
            return undefined;
        }
        if (raw.length <= ENVELOPE_MAGIC.length + gcmIvLength + gcmTagLength) return undefined;
        if (!raw.subarray(0, ENVELOPE_MAGIC.length).equals(ENVELOPE_MAGIC)) return undefined;
        const key = await this.#deriveKey(stateDir, false);
        if (key === null) return undefined;
        try {
            const ivOffset = ENVELOPE_MAGIC.length;
            const tagOffset = ivOffset + gcmIvLength;
            const cipherOffset = tagOffset + gcmTagLength;
            const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(ivOffset, tagOffset));
            decipher.setAAD(SecretStore.#aad(scope, alias));
            decipher.setAuthTag(raw.subarray(tagOffset, cipherOffset));
            const plaintext = Buffer.concat([decipher.update(raw.subarray(cipherOffset)), decipher.final()]).toString("utf8");
            const parsed: unknown = JSON.parse(plaintext);
            if (!isRecord(parsed) || parsed.version !== 1 || parsed.alias !== alias || !isRecord(parsed.secrets)) {
                return undefined;
            }
            const secrets: Record<string, string> = {};
            for (const [k, v] of Object.entries(parsed.secrets)) {
                if (SECRET_KEY_NAME.test(k) && !isReservedPlurnkKey(k) && typeof v === "string") {
                    secrets[k] = v;
                }
            }
            if (Object.keys(secrets).length === 0) return undefined;
            const projectDefinition = isRecord(parsed.projectDefinition)
                ? readDefinition(parsed.projectDefinition, alias)
                : undefined;
            return {
                alias,
                secrets,
                ...(projectDefinition === undefined ? {} : { projectDefinition }),
            };
        } catch {
            return undefined;
        }
    }

    async #writeUnlocked(scope: GrantScope, entry: StoredSecretEntry): Promise<void> {
        const stateDir = await this.#directory(scope);
        const sortedEntries = Object.entries(entry.secrets).toSorted(([a], [b]) => a.localeCompare(b));
        if (sortedEntries.length === 0) {
            await rm(join(stateDir, SecretStore.fileName(entry.alias)), { force: true });
            return;
        }
        await mkdir(stateDir, { recursive: true, mode: 0o700 });
        const key = await this.#deriveKey(stateDir, true);
        if (key === null) return;
        const envelope: StoredMcpSecretsEnvelope = {
            version: 1,
            alias: entry.alias,
            secrets: Object.fromEntries(sortedEntries),
            ...(entry.projectDefinition === undefined ? {} : { projectDefinition: entry.projectDefinition }),
        };
        const iv = randomBytes(gcmIvLength);
        const cipher = createCipheriv("aes-256-gcm", key, iv);
        cipher.setAAD(SecretStore.#aad(scope, entry.alias));
        const ciphertext = Buffer.concat([cipher.update(JSON.stringify(envelope), "utf8"), cipher.final()]);
        const tag = cipher.getAuthTag();
        const bytes = Buffer.concat([ENVELOPE_MAGIC, iv, tag, ciphertext]);
        const fileName = SecretStore.fileName(entry.alias);
        const stage = join(stateDir, `.${fileName}-${process.pid}-${++this.#writeSeq}`);
        await writeFile(stage, bytes, { mode: 0o600, flag: "w" });
        await rename(stage, join(stateDir, fileName));
    }

    load(scope: GrantScope, alias: string): Promise<StoredSecretEntry | undefined> {
        return this.#queue(scope, alias, () => this.#readUnlocked(scope, alias));
    }

    async loadForDefinition(scope: GrantScope, alias: string, definition: McpServerDefinition): Promise<Readonly<Record<string, string>>> {
        const stored = await this.load(scope, alias);
        if (stored === undefined) return {};
        if (stored.projectDefinition !== undefined && !isDeepStrictEqual(stored.projectDefinition, definition)) {
            return {};
        }
        return stored.secrets;
    }

    async has(scope: GrantScope, alias: string): Promise<boolean> {
        const stored = await this.load(scope, alias);
        return stored !== undefined && Object.keys(stored.secrets).length > 0;
    }

    set(
        scope: GrantScope,
        alias: string,
        patch: Readonly<Record<string, string>>,
        projectDefinition?: McpServerDefinition | null,
    ): Promise<readonly string[]> {
        return this.#queue(scope, alias, async () => {
            const current = await this.#readUnlocked(scope, alias);
            const merged: Record<string, string> = {
                ...current?.secrets,
                ...patch,
            };
            const effectiveProjectDef = projectDefinition === null
                ? undefined
                : (projectDefinition ?? current?.projectDefinition);
            await this.#writeUnlocked(scope, {
                alias,
                secrets: merged,
                ...(effectiveProjectDef === undefined ? {} : { projectDefinition: effectiveProjectDef }),
            });
            return Object.keys(merged).toSorted();
        });
    }

    unset(scope: GrantScope, alias: string, keys?: readonly string[]): Promise<readonly string[]> {
        return this.#queue(scope, alias, async () => {
            if (keys === undefined) {
                if (scope !== "service" || this.#serviceStateDirectory !== undefined) {
                    const stateDir = await this.#directory(scope);
                    await rm(join(stateDir, SecretStore.fileName(alias)), { force: true });
                }
                return [];
            }
            const current = await this.#readUnlocked(scope, alias);
            if (current === undefined) return [];
            const next: Record<string, string> = { ...current.secrets };
            for (const key of keys) delete next[key];
            await this.#writeUnlocked(scope, {
                alias,
                secrets: next,
                ...(current.projectDefinition === undefined ? {} : { projectDefinition: current.projectDefinition }),
            });
            return Object.keys(next).toSorted();
        });
    }

    delete(scope: GrantScope, alias: string): Promise<void> {
        return this.#queue(scope, alias, async () => {
            if (scope === "service" && this.#serviceStateDirectory === undefined) return;
            const stateDir = await this.#directory(scope);
            await rm(join(stateDir, SecretStore.fileName(alias)), { force: true });
        });
    }

    async listByServer(scope: GrantScope): Promise<Readonly<Record<string, StoredSecretEntry>>> {
        if (scope === "service" && this.#serviceStateDirectory === undefined) return {};
        const stateDir = await this.#directory(scope);
        let files: string[];
        try {
            files = await readdir(stateDir);
        } catch {
            return {};
        }
        const out: Record<string, StoredSecretEntry> = {};
        for (const file of files) {
            if (!file.startsWith(FILE_PREFIX) || !file.endsWith(FILE_SUFFIX)) continue;
            let alias: string;
            try {
                alias = decodeURIComponent(file.slice(FILE_PREFIX.length, -FILE_SUFFIX.length));
            } catch {
                continue;
            }
            if (!alias) continue;
            const loaded = await this.load(scope, alias);
            if (loaded !== undefined && Object.keys(loaded.secrets).length > 0) {
                out[alias] = loaded;
            }
        }
        return out;
    }
}
