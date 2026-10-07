import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import SqlRiteSync from "@possumtech/sqlrite/sync";
import Digest from "./Digest.ts";
import type { Provider } from "@plurnk/plurnk-providers";
import type { OpenEvidence } from "./evidence.ts";

export interface ShareOptions {
    readonly openEvidence: OpenEvidence;
    readonly dbPath: string;
    readonly folder: string;
    // {§share-scope}: absent shares the whole database.
    readonly workspaceId?: number;
    // {§digest-requiem}: also run the out-of-band forensic interview over the shared record.
    readonly requiem?: Provider;
}

// {§share}: a share is the digest of a consistent copy of the database.
export default class Share {
    // {§share-snapshot}: a live or WAL-mode database is copied by SQLite, never by the filesystem.
    static snapshot(dbPath: string, copy: string): void {
        const source = resolve(dbPath);
        if (!existsSync(source)) throw new Error(`share: no database at ${source}`);
        if (existsSync(copy)) throw new Error(`share: ${resolve(copy)} already exists; remove it first`);
        using database = new SqlRiteSync({ path: source, dir: [import.meta.dirname] });
        database.share_snapshot.run({ path: resolve(copy) });
    }

    static async write({ dbPath, folder, workspaceId, requiem, openEvidence }: ShareOptions): Promise<{ folder: string }> {
        const target = resolve(folder);
        const scratch = mkdtempSync(join(tmpdir(), "plurnk-share-"));
        try {
            const copy = join(scratch, "plurnk.db");
            Share.snapshot(dbPath, copy);
            const scoped = { openEvidence, dbPath: copy, digestDir: target, ...(workspaceId === undefined ? {} : { workspaceId }) };
            Digest.run(scoped);
            if (requiem) await Digest.requiem({ ...scoped, provider: requiem });
        } finally {
            rmSync(scratch, { recursive: true, force: true });
        }
        return { folder: target };
    }
}
