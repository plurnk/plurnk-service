import fs from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import { dirname, join } from "node:path";
import { contentHash } from "./content-hash.ts";
import FileSnapshot, { type FileRevision } from "./FileSnapshot.ts";

export type PublishedFile =
    | { readonly status: "conflict" }
    | { readonly status: "published"; readonly revision: FileRevision }
    | { readonly status: "failed"; readonly published: boolean; readonly cause: unknown };

// {§file-publication}: caller holds the physical path's commit boundary through projection settlement.
export default class FilePublication {
    static async write(requested: string, canonical: string, baseline: FileRevision | null, bytes: Uint8Array): Promise<PublishedFile> {
        let directory: string | undefined;
        let published = false;
        let result: PublishedFile = { status: "conflict" };
        try {
            await fs.mkdir(dirname(canonical), { recursive: true });
            directory = await fs.mkdtemp(join(dirname(canonical), ".plurnk-write-"));
            const staged = join(directory, "content");
            let identity: BigIntStats;
            {
                await using handle = await fs.open(staged, "wx", 0o600);
                identity = await handle.stat({ bigint: true });
                await handle.writeFile(bytes);
                const source = baseline === null ? null : await FileSnapshot.observe(requested);
                const current = await handle.stat({ bigint: true });
                if (source !== null && (current.uid !== source.stats.uid || current.gid !== source.stats.gid)) {
                    await handle.chown(Number(source.stats.uid), Number(source.stats.gid));
                }
                await handle.chmod(source === null ? 0o666 & ~process.umask() : Number(source.stats.mode & 0o7777n));
                await handle.sync();
            }
            if (baseline !== null) {
                const current = await FileSnapshot.acquire(requested, null);
                if (current === null || !FileSnapshot.matches(baseline, current.revision)) {
                    result = { status: "conflict" };
                } else {
                    await fs.rename(staged, canonical);
                    published = true;
                }
            } else if (await FileSnapshot.prospectivePath(requested) === canonical) {
                // Linking the completed same-filesystem stage publishes without replacing any occupant.
                try {
                    await fs.link(staged, canonical);
                    published = true;
                    await fs.unlink(staged);
                } catch (cause) {
                    if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
                    result = { status: "conflict" };
                }
            }
            if (published) {
                const landed = await FileSnapshot.acquire(requested, null);
                if (landed === null || landed.stats.dev !== identity.dev || landed.stats.ino !== identity.ino
                    || landed.revision.canonical !== canonical || landed.revision.hash !== contentHash(bytes)) {
                    result = { status: "failed", published, cause: new Error("The published file changed before its projection could be recorded.") };
                } else {
                    result = { status: "published", revision: landed.revision };
                }
            }
        } catch (cause) {
            result = { status: "failed", published, cause };
        } finally {
            if (directory !== undefined) {
                try {
                    await fs.rm(join(directory, "content"), { force: true });
                    await fs.rmdir(directory);
                } catch (cause) {
                    result = { status: "failed", published, cause: new AggregateError(
                        result.status === "failed" ? [result.cause, cause] : [cause], "File staging cleanup failed.",
                    ) };
                }
            }
        }
        return result;
    }
}
