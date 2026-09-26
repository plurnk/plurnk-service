import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import SqlRiteSync from "@possumtech/sqlrite/sync";
import Digest from "../digest/Digest.ts";
import HostPaths from "../core/HostPaths.ts";
import Zip from "./Zip.ts";

export interface ShareOptions {
    readonly dbPath: string;
    readonly folder: string;
    // {§share-scope}: absent shares the whole database.
    readonly workspaceId?: number;
    // {§digest-requiem}: also run the out-of-band forensic interview over the shared record.
    readonly requiem?: boolean;
}

// {§share}: a share is the digest of a consistent copy of the database, and a ZIP of it beside the folder.
export default class Share {
    // {§share-folder}: the configured share folder, or the XDG state default; each share is a stamped child.
    static defaultFolder(env: NodeJS.ProcessEnv = process.env, paths = new HostPaths(), now = new Date()): string {
        const configured = env.PLURNK_SERVICE_SHARE_FOLDER;
        const root = configured === undefined || configured === ""
            ? join(paths.stateDir, "shares")
            : resolve(paths.expandUserPath(configured));
        return join(root, `share-${now.toISOString().replace(/[-:]/gu, "").replace(/\.\d+Z$/u, "Z")}`);
    }

    // {§share-snapshot}: a live or WAL-mode database is copied by SQLite, never by the filesystem.
    static snapshot(dbPath: string, copy: string): void {
        const source = resolve(dbPath);
        if (!existsSync(source)) throw new Error(`share: no database at ${source}`);
        if (existsSync(copy)) throw new Error(`share: ${resolve(copy)} already exists; remove it first`);
        using database = new SqlRiteSync({ path: source, dir: [import.meta.dirname] });
        database.share_snapshot.run({ path: resolve(copy) });
    }

    static async write({ dbPath, folder, workspaceId, requiem = false }: ShareOptions): Promise<{ folder: string; zip: string }> {
        const target = resolve(folder);
        const zip = `${target}.zip`;
        if (existsSync(zip)) throw new Error(`share: ${zip} already exists; remove it first`);
        const scratch = mkdtempSync(join(tmpdir(), "plurnk-share-"));
        try {
            const copy = join(scratch, "plurnk.db");
            Share.snapshot(dbPath, copy);
            const scoped = { dbPath: copy, digestDir: target, ...(workspaceId === undefined ? {} : { workspaceId }) };
            Digest.run(scoped);
            if (requiem) await Digest.requiem(scoped);
        } finally {
            rmSync(scratch, { recursive: true, force: true });
        }
        Zip.writeFolder(target, zip);
        return { folder: target, zip };
    }
}
