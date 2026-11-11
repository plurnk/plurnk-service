import { errnoCode } from "@plurnk/plurnk-contracts";
import fs from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import { dirname, join } from "node:path";
import { contentHash } from "./content-hash.ts";
import FileSnapshot, { type FileRevision } from "./FileSnapshot.ts";

export type PublishedFile =
    | { readonly status: "conflict" }
    | { readonly status: "published"; readonly revision: FileRevision }
    | { readonly status: "failed"; readonly published: boolean; readonly cause: unknown };

const ensureParentDirectory = async (parent: string): Promise<{ uid: bigint; gid: bigint } | null> => {
    if (process.geteuid?.() !== 0) {
        await fs.mkdir(parent, { recursive: true });
        return null;
    }
    const missing: string[] = [];
    let current = parent;
    let ancestor: BigIntStats | null = null;
    while (true) {
        try {
            ancestor = await fs.stat(current, { bigint: true });
            break;
        } catch (cause) {
            if (errnoCode(cause) !== "ENOENT") throw cause;
            missing.unshift(current);
            const next = dirname(current);
            if (next === current) break;
            current = next;
        }
    }
    await fs.mkdir(parent, { recursive: true });
    if (ancestor === null || (ancestor.uid === 0n && ancestor.gid === 0n)) {
        return null;
    }
    for (const created of missing) {
        await fs.chown(created, Number(ancestor.uid), Number(ancestor.gid));
    }
    return { uid: ancestor.uid, gid: ancestor.gid };
};

// {§file-snapshot-revision}: caller holds the physical path's commit boundary through projection settlement.
export default class FilePublication {
    static async write(requested: string, canonical: string, baseline: FileRevision | null, bytes: Uint8Array): Promise<PublishedFile> {
        let directory: string | undefined;
        let published = false;
        let result: PublishedFile = { status: "conflict" };
        try {
            const inheritedOwner = await ensureParentDirectory(dirname(canonical));
            directory = await fs.mkdtemp(join(dirname(canonical), ".plurnk-write-"));
            const staged = join(directory, "content");
            let identity: BigIntStats;
            {
                // A created file takes the ordinary creation mode: 0o666 under the process umask, applied by the kernel at open.
                await using handle = await fs.open(staged, "wx", 0o666);
                identity = await handle.stat({ bigint: true });
                await handle.writeFile(bytes);
                const source = baseline === null ? null : await FileSnapshot.observe(requested);
                const current = await handle.stat({ bigint: true });
                if (source !== null && (current.uid !== source.stats.uid || current.gid !== source.stats.gid)) {
                    await handle.chown(Number(source.stats.uid), Number(source.stats.gid));
                } else if (source === null && inheritedOwner !== null && (current.uid !== inheritedOwner.uid || current.gid !== inheritedOwner.gid)) {
                    await handle.chown(Number(inheritedOwner.uid), Number(inheritedOwner.gid));
                }
                if (source !== null) await handle.chmod(Number(source.stats.mode & 0o7777n));
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
                    if (errnoCode(cause) !== "EEXIST") throw cause;
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
