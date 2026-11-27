// {§operator-config-precedence} Encrypted host-local storage for service-tier secret configuration
// values (`$XDG_STATE_HOME/plurnk/config-secrets.enc`), strictly outside SQLite so `plurnk-service share`
// and database snapshots never carry provider credentials or secret tokens.

import { errnoCode, isRecord } from "@plurnk/plurnk-contracts";
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type HostPaths from "./HostPaths.ts";

const ENVELOPE_MAGIC = Buffer.from("PLKCFG01", "ascii");
const CONFIG_PURPOSE = "config-secrets";
const CONFIG_SECRETS_FILE = "config-secrets.enc";
const KEY_FILE = ".config-key";
const gcmIvLength = 12;
const gcmTagLength = 16;
const hkdfKeyLength = 32;

export interface ServiceSecretStoreOptions {
    readonly fileName?: string;
    readonly purpose?: string;
}

interface StoredConfigSecretsEnvelope {
    readonly version: 1;
    readonly entries: Readonly<Record<string, string>>;
}

export default class ServiceSecretStore {
    readonly #stateDir: string;
    readonly #fileName: string;
    readonly #filePath: string;
    readonly #keyPath: string;
    readonly #hkdfInfo: Buffer;
    readonly #aad: Buffer;
    #queue: Promise<void> = Promise.resolve();
    #writeSeq = 0;

    constructor(hostPaths: Pick<HostPaths, "stateDir">, options: ServiceSecretStoreOptions = {}) {
        const purpose = options.purpose ?? CONFIG_PURPOSE;
        this.#stateDir = hostPaths.stateDir;
        this.#fileName = options.fileName ?? CONFIG_SECRETS_FILE;
        this.#filePath = join(this.#stateDir, this.#fileName);
        this.#keyPath = join(this.#stateDir, KEY_FILE);
        this.#hkdfInfo = Buffer.from(`plurnk-service/${purpose}/v1`, "utf8");
        this.#aad = Buffer.from(`plurnk-service/${purpose}/v1:entries`, "utf8");
    }

    get filePath(): string {
        return this.#filePath;
    }

    #enqueue<T>(work: () => Promise<T>): Promise<T> {
        const task = this.#queue.catch(() => undefined).then(work);
        this.#queue = task.then(() => undefined, () => undefined);
        return task;
    }

    #deriveHkdfKey(master: Buffer): Buffer {
        return Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), this.#hkdfInfo, hkdfKeyLength));
    }

    #decrypt(raw: Buffer, key: Buffer): Map<string, string> {
        if (raw.length <= ENVELOPE_MAGIC.length + gcmIvLength + gcmTagLength) {
            throw new Error("corrupt service secret store envelope");
        }
        if (!raw.subarray(0, ENVELOPE_MAGIC.length).equals(ENVELOPE_MAGIC)) {
            throw new Error("invalid service secret store magic");
        }
        const ivOffset = ENVELOPE_MAGIC.length;
        const tagOffset = ivOffset + gcmIvLength;
        const cipherOffset = tagOffset + gcmTagLength;
        const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(ivOffset, tagOffset));
        decipher.setAAD(this.#aad);
        decipher.setAuthTag(raw.subarray(tagOffset, cipherOffset));
        const plaintext = Buffer.concat([decipher.update(raw.subarray(cipherOffset)), decipher.final()]).toString("utf8");
        const parsed: unknown = JSON.parse(plaintext);
        if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.entries)) {
            throw new Error("invalid service secret store payload");
        }
        const out = new Map<string, string>();
        for (const [entryKey, entryValue] of Object.entries(parsed.entries)) {
            if (typeof entryValue === "string") out.set(entryKey, entryValue);
        }
        return out;
    }

    #encrypt(entries: ReadonlyMap<string, string>, key: Buffer): Buffer {
        const envelope: StoredConfigSecretsEnvelope = {
            version: 1,
            entries: Object.fromEntries([...entries.entries()].toSorted(([a], [b]) => a.localeCompare(b))),
        };
        const iv = randomBytes(gcmIvLength);
        const cipher = createCipheriv("aes-256-gcm", key, iv);
        cipher.setAAD(this.#aad);
        const ciphertext = Buffer.concat([cipher.update(JSON.stringify(envelope), "utf8"), cipher.final()]);
        const tag = cipher.getAuthTag();
        return Buffer.concat([ENVELOPE_MAGIC, iv, tag, ciphertext]);
    }

    loadSync(): Map<string, string> {
        let raw: Buffer;
        try {
            raw = readFileSync(this.#filePath);
        } catch (cause) {
            if (errnoCode(cause) === "ENOENT") return new Map();
            throw cause;
        }
        let master: Buffer;
        try {
            master = readFileSync(this.#keyPath);
        } catch (cause) {
            if (errnoCode(cause) === "ENOENT") return new Map();
            throw cause;
        }
        if (master.length < hkdfKeyLength) return new Map();
        return this.#decrypt(raw, this.#deriveHkdfKey(master));
    }

    async #deriveKey(createIfMissing: boolean): Promise<Buffer | null> {
        try {
            const existing = await readFile(this.#keyPath);
            if (existing.length < hkdfKeyLength) throw new Error("invalid config secret key length");
            return this.#deriveHkdfKey(existing);
        } catch (cause) {
            if (!createIfMissing) {
                if (errnoCode(cause) === "ENOENT") return null;
                throw cause;
            }
            await mkdir(this.#stateDir, { recursive: true, mode: 0o700 });
            const master = randomBytes(hkdfKeyLength);
            const stage = join(this.#stateDir, `.config-key-${process.pid}-${++this.#writeSeq}`);
            await writeFile(stage, master, { mode: 0o600, flag: "w" });
            await rename(stage, this.#keyPath);
            return this.#deriveHkdfKey(master);
        }
    }

    async #readUnlocked(): Promise<Map<string, string>> {
        let raw: Buffer;
        try {
            raw = await readFile(this.#filePath);
        } catch (cause) {
            if (errnoCode(cause) === "ENOENT") return new Map();
            throw cause;
        }
        const key = await this.#deriveKey(false);
        if (key === null) return new Map();
        return this.#decrypt(raw, key);
    }

    async #writeUnlocked(entries: ReadonlyMap<string, string>): Promise<void> {
        mkdirSync(dirname(this.#filePath), { recursive: true, mode: 0o700 });
        const key = await this.#deriveKey(true);
        if (key === null) throw new Error("failed to derive service secret store key");
        const bytes = this.#encrypt(entries, key);
        const stage = join(this.#stateDir, `.${this.#fileName}-${process.pid}-${++this.#writeSeq}`);
        await writeFile(stage, bytes, { mode: 0o600, flag: "w" });
        await rename(stage, this.#filePath);
    }

    load(): Promise<Map<string, string>> {
        return this.#enqueue(() => this.#readUnlocked());
    }

    set(key: string, value: string): Promise<Map<string, string>> {
        return this.#enqueue(async () => {
            const entries = await this.#readUnlocked();
            entries.set(key, value);
            await this.#writeUnlocked(entries);
            return entries;
        });
    }

    delete(key: string): Promise<{ readonly removed: boolean; readonly entries: Map<string, string> }> {
        return this.#enqueue(async () => {
            const entries = await this.#readUnlocked();
            const removed = entries.delete(key);
            if (removed) await this.#writeUnlocked(entries);
            return { removed, entries };
        });
    }
}
