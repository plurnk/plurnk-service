import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isRecord, type McpServerDefinition } from "@plurnk/plurnk-contracts";
import type { PluginContext } from "./PluginConfiguration.ts";
import { OWNER, type McpBinding } from "./attachment.ts";
import { readDefinition } from "./definition.ts";
import { OAuthGrant, type SerializedOAuthGrant } from "./oauth.ts";

const ENVELOPE_MAGIC = Buffer.from("PLKMCPG1", "ascii");
const HKDF_INFO = Buffer.from("plurnk-mcp/oauth/v1", "utf8");
const LOCAL_KEY_FILE = ".oauth-key";
const gcmIvLength = 12;
const gcmTagLength = 16;
const hkdfKeyLength = 32;

interface StoredMcpGrantEnvelope {
    readonly version: 1;
    readonly alias: string;
    readonly definition: McpServerDefinition;
    readonly context?: PluginContext;
    readonly grant: SerializedOAuthGrant;
}

export type StoredGrantEntry = McpBinding & { readonly grant: OAuthGrant };

// {§oauth-continuation} Encrypted per-workspace, per-alias MCP OAuth grant storage outside SQLite.
export default class GrantStore {
    readonly #stateDirectory: (workspaceId: number, owner: string) => Promise<string>;
    readonly #operatorSecret: () => string | null;
    readonly #queues = new Map<string, Promise<void>>();
    #writeSeq = 0;

    constructor({
        stateDirectory,
        operatorSecret,
    }: {
        readonly stateDirectory: (workspaceId: number, owner: string) => Promise<string>;
        readonly operatorSecret: () => string | null;
    }) {
        this.#stateDirectory = stateDirectory;
        this.#operatorSecret = operatorSecret;
    }

    static fileName(alias: string): string {
        return `oauth-${encodeURIComponent(alias)}.enc`;
    }

    #queue<T>(workspaceId: number, alias: string, work: () => Promise<T>): Promise<T> {
        const key = `${workspaceId}:${alias}`;
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
        const configured = this.#operatorSecret();
        let master: Buffer;
        if (configured !== null && configured.length > 0) {
            master = Buffer.from(configured, "utf8");
        } else {
            const keyPath = join(stateDir, LOCAL_KEY_FILE);
            try {
                const existing = await readFile(keyPath);
                if (existing.length < hkdfKeyLength) throw new Error("invalid local key length");
                master = existing;
            } catch {
                if (!createLocalKey) return null;
                await mkdir(stateDir, { recursive: true, mode: 0o700 });
                master = randomBytes(hkdfKeyLength);
                const stage = join(stateDir, `.oauth-key-${process.pid}-${++this.#writeSeq}`);
                await writeFile(stage, master, { mode: 0o600, flag: "w" });
                await rename(stage, keyPath);
            }
        }
        return Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), HKDF_INFO, hkdfKeyLength));
    }

    static #aad(workspaceId: number, alias: string): Buffer {
        return Buffer.from(`plurnk-mcp/oauth/v1:${workspaceId}:${alias}`, "utf8");
    }

    load(workspaceId: number, alias: string): Promise<StoredGrantEntry | undefined> {
        return this.#queue(workspaceId, alias, async () => {
            const stateDir = await this.#stateDirectory(workspaceId, OWNER);
            const path = join(stateDir, GrantStore.fileName(alias));
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
                decipher.setAAD(GrantStore.#aad(workspaceId, alias));
                decipher.setAuthTag(raw.subarray(tagOffset, cipherOffset));
                const plaintext = Buffer.concat([decipher.update(raw.subarray(cipherOffset)), decipher.final()]).toString("utf8");
                const parsed: unknown = JSON.parse(plaintext);
                if (!isRecord(parsed) || parsed.version !== 1 || parsed.alias !== alias || !isRecord(parsed.definition) || !isRecord(parsed.grant)) {
                    return undefined;
                }
                const grant = OAuthGrant.fromJSON(parsed.grant);
                if (!grant.signedIn) return undefined;
                const definition = readDefinition(parsed.definition, alias);
                const context = isRecord(parsed.context) && typeof parsed.context.root === "string" && typeof parsed.context.data === "string"
                    ? { root: parsed.context.root, data: parsed.context.data }
                    : undefined;
                return {
                    alias,
                    definition,
                    ...(context === undefined ? {} : { context }),
                    grant,
                };
            } catch {
                // Rotated host secret or corrupted grant file fails closed to unsigned state.
                return undefined;
            }
        });
    }

    save(workspaceId: number, entry: StoredGrantEntry): Promise<void> {
        return this.#queue(workspaceId, entry.alias, async () => {
            const stateDir = await this.#stateDirectory(workspaceId, OWNER);
            await mkdir(stateDir, { recursive: true, mode: 0o700 });
            const key = await this.#deriveKey(stateDir, true);
            if (key === null) return;
            const envelope: StoredMcpGrantEnvelope = {
                version: 1,
                alias: entry.alias,
                definition: entry.definition,
                ...(entry.context === undefined ? {} : { context: entry.context }),
                grant: entry.grant.toJSON(),
            };
            const iv = randomBytes(gcmIvLength);
            const cipher = createCipheriv("aes-256-gcm", key, iv);
            cipher.setAAD(GrantStore.#aad(workspaceId, entry.alias));
            const ciphertext = Buffer.concat([cipher.update(JSON.stringify(envelope), "utf8"), cipher.final()]);
            const tag = cipher.getAuthTag();
            const bytes = Buffer.concat([ENVELOPE_MAGIC, iv, tag, ciphertext]);
            const fileName = GrantStore.fileName(entry.alias);
            const stage = join(stateDir, `.${fileName}-${process.pid}-${++this.#writeSeq}`);
            await writeFile(stage, bytes, { mode: 0o600, flag: "w" });
            await rename(stage, join(stateDir, fileName));
        });
    }

    delete(workspaceId: number, alias: string): Promise<void> {
        return this.#queue(workspaceId, alias, async () => {
            const stateDir = await this.#stateDirectory(workspaceId, OWNER);
            await rm(join(stateDir, GrantStore.fileName(alias)), { force: true });
        });
    }
}
