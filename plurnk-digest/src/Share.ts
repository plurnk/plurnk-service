import { errnoCode } from "@plurnk/plurnk-contracts";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import SqlRiteSync from "@possumtech/sqlrite/sync";
import Digest from "./Digest.ts";
import type { Provider } from "@plurnk/plurnk-providers";
import type { OpenEvidence } from "./evidence.ts";

export interface ShareOptions {
    readonly openEvidence: OpenEvidence;
    readonly dbPath: string;
    readonly folder: string;
    // {§share}: absent shares the whole database.
    readonly workspaceId?: number;
    // {§digest-requiem}: also run the out-of-band forensic interview over the shared record.
    readonly requiem?: Provider;
}

// {§share}: a share is the digest of a consistent copy of the database.
export default class Share {
    // {§share-packet-names}: a live or WAL-mode database is copied by SQLite, never by the filesystem.
    static snapshot(dbPath: string, copy: string): void {
        const source = resolve(dbPath);
        if (!existsSync(source)) throw new Error(`no database at ${source}`);
        if (existsSync(copy)) throw new Error(`${resolve(copy)} already exists; remove it first`);
        using database = new SqlRiteSync({ path: source, dir: [import.meta.dirname] });
        database.share_snapshot.run({ path: resolve(copy) });
    }

    static #createScratch(target: string): string {
        const parent = dirname(target);
        try {
            mkdirSync(parent, { recursive: true });
            return mkdtempSync(join(parent, ".plurnk-share-"));
        } catch (cause) {
            const code = errnoCode(cause);
            const xdgCache = process.env.XDG_CACHE_HOME?.trim();
            if ((code === "EACCES" || code === "EPERM" || code === "EROFS") && xdgCache) {
                const cacheDir = join(resolve(xdgCache), "plurnk");
                mkdirSync(cacheDir, { recursive: true });
                return mkdtempSync(join(cacheDir, ".plurnk-share-"));
            }
            throw cause;
        }
    }

    static async write({ dbPath, folder, workspaceId, requiem, openEvidence }: ShareOptions): Promise<{ folder: string }> {
        const source = resolve(dbPath);
        if (!existsSync(source)) throw new Error(`no database at ${source}`);
        if (folder.length === 0) throw new Error("output directory must not be empty");
        const target = resolve(folder);
        if (existsSync(target) && (!statSync(target).isDirectory() || readdirSync(target).length > 0)) {
            throw new Error(`${target} already exists and is not an empty folder; remove it first`);
        }
        const scratch = Share.#createScratch(target);
        try {
            const copy = join(scratch, "plurnk.db");
            Share.snapshot(source, copy);
            const scoped = { openEvidence, dbPath: copy, digestDir: target, ...(workspaceId === undefined ? {} : { workspaceId }) };
            Digest.run(scoped);
            if (requiem) await Digest.requiem({ ...scoped, provider: requiem });
        } finally {
            rmSync(scratch, { recursive: true, force: true });
        }
        return { folder: target };
    }
}
