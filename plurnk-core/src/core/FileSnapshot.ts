import fs from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";

export interface FileRevision {
    readonly canonical: string;
    readonly fingerprint: string;
    readonly hash: string | null;
}

export interface FileObservation {
    readonly canonical: string;
    readonly stats: BigIntStats;
    readonly fingerprint: string;
}

export interface AcquiredFile extends FileObservation {
    readonly revision: FileRevision;
    readonly bytes: Buffer | null;
}

// {§file-snapshot-revision}, {§file-commit-serialization}, {§file-external-race}
export default class FileSnapshot {
    static readonly #commits = new Map<string, Promise<void>>();

    static async serialize<T>(canonical: string, commit: () => Promise<T>): Promise<T> {
        const previous = FileSnapshot.#commits.get(canonical);
        const released = Promise.withResolvers<void>();
        FileSnapshot.#commits.set(canonical, released.promise);
        try {
            await previous;
            return await commit();
        } finally {
            released.resolve();
            if (FileSnapshot.#commits.get(canonical) === released.promise) FileSnapshot.#commits.delete(canonical);
        }
    }

    static fingerprint(st: BigIntStats): string {
        return [st.dev, st.ino, st.size, st.mtimeNs, st.ctimeNs, st.mode, st.uid, st.gid, st.nlink].join(":");
    }

    static decode(encoded: string | null): FileRevision | null {
        if (encoded === null || encoded === "absent") return null;
        const revision = JSON.parse(encoded) as FileRevision;
        if (typeof revision.canonical !== "string" || typeof revision.fingerprint !== "string"
            || (revision.hash !== null && typeof revision.hash !== "string")) {
            throw new TypeError("A stored file revision is malformed.");
        }
        return revision;
    }

    static matches(expected: FileRevision, observed: FileRevision): boolean {
        return expected.canonical === observed.canonical
            && expected.fingerprint === observed.fingerprint
            && (expected.hash === null || expected.hash === observed.hash);
    }

    static async observe(path: string): Promise<FileObservation | null> {
        try {
            const canonical = await fs.realpath(path);
            const stats = await fs.stat(canonical, { bigint: true });
            return { canonical, stats, fingerprint: FileSnapshot.fingerprint(stats) };
        } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
            throw cause;
        }
    }

    // Resolve an absent name through its nearest existing ancestor, including symlinked parents.
    static async prospectivePath(requested: string): Promise<string> {
        const tail = [basename(requested)];
        let cursor = dirname(requested);
        while (true) {
            try {
                return join(await fs.realpath(cursor), ...tail);
            } catch (cause) {
                if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
            }
            const parent = dirname(cursor);
            if (parent === cursor) throw new Error(`No existing ancestor contains '${requested}'.`);
            tail.unshift(basename(cursor));
            cursor = parent;
        }
    }

    // Read a fixed extent through one descriptor, then verify both that descriptor and its name.
    // A growing file cannot turn the bounded snapshot into an unbounded read.
    static async acquire(path: string, maximumBytes: number | null): Promise<AcquiredFile | null> {
        const observed = await FileSnapshot.observe(path);
        if (observed === null || !observed.stats.isFile()) return null;
        let handle;
        try {
            handle = await fs.open(observed.canonical, "r");
        } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
            throw cause;
        }
        await using descriptor = handle;
        const initial = await descriptor.stat({ bigint: true });
        if (FileSnapshot.fingerprint(initial) !== observed.fingerprint) return null;
        if (maximumBytes !== null && initial.size > BigInt(maximumBytes)) return null;
        const hash = createHash("sha256");
        const chunks: Buffer[] = [];
        let length = 0;
        if (initial.size > 0n) {
            for await (const chunk of descriptor.createReadStream({ autoClose: false, start: 0, end: Number(initial.size) - 1 })) {
                const bytes = chunk as Buffer;
                hash.update(bytes);
                length += bytes.length;
                if (maximumBytes !== null) chunks.push(bytes);
            }
        }
        const final = await descriptor.stat({ bigint: true });
        const current = await FileSnapshot.observe(path);
        if (BigInt(length) !== initial.size || FileSnapshot.fingerprint(final) !== observed.fingerprint
            || current?.canonical !== observed.canonical || current.fingerprint !== observed.fingerprint) return null;
        return {
            ...observed,
            revision: { canonical: observed.canonical, fingerprint: observed.fingerprint, hash: hash.digest("hex") },
            bytes: maximumBytes !== null ? Buffer.concat(chunks, length) : null,
        };
    }
}
