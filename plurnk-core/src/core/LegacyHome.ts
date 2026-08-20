import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { constants } from "node:fs";
import {
    access,
    chmod,
    copyFile,
    lstat,
    mkdir,
    readdir,
    rmdir,
    stat,
    unlink,
} from "node:fs/promises";
import { join } from "node:path";
import type HostPaths from "./HostPaths.ts";
import DaemonLock from "../server/DaemonLock.ts";

const CONFIG_MEMBERS = new Map([
    [".env", ".env"],
    ["AGENTS.md", "AGENTS.md"],
]);
const DATA_MEMBERS = new Map([
    ["plurnk.db", "plurnk.db"],
    ["plurnk.db-wal", "plurnk.db-wal"],
    ["plurnk.db-shm", "plurnk.db-shm"],
]);
const GENERATED_MEMBERS = new Set([".env.defaults", ".env.example", "INSTALL.md"]);
const LOCK_MEMBER = "plurnk.db.lock";

const exists = async (path: string): Promise<boolean> => access(path, constants.F_OK)
    .then(() => true)
    .catch(() => false);

const hashFile = async (path: string): Promise<string> => {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest("hex");
};

const copyVerified = async (source: string, destination: string): Promise<void> => {
    const sourceStat = await stat(source);
    let created = false;
    try {
        await copyFile(source, destination, constants.COPYFILE_EXCL);
        created = true;
        await chmod(destination, sourceStat.mode & 0o777);
        const [sourceHash, destinationHash] = await Promise.all([hashFile(source), hashFile(destination)]);
        if (sourceHash !== destinationHash) {
            throw new Error(`copy verification failed: ${source} -> ${destination}`);
        }
    } catch (cause) {
        if (created) await unlink(destination).catch(() => {});
        throw cause;
    }
};

export interface LegacyMigrationMove {
    readonly source: string;
    readonly destination: string;
}

// {§legacy-home-transition} — the only reader of the retired mixed home. It is
// an explicit one-way operation, not a compatibility path used by the daemon.
export default class LegacyHome {
    static async assertCanonical(paths: HostPaths): Promise<void> {
        if (!await exists(paths.legacyDir)) return;
        const canonical = await Promise.all([exists(paths.configDir), exists(paths.dataDir)]);
        if (canonical.some(Boolean)) {
            throw new Error(
                `legacy ${paths.legacyDir} and canonical Plurnk paths both exist; `
                + "resolve the conflict without guessing, then run plurnk-service paths migrate",
            );
        }
        throw new Error(`legacy Plurnk home found at ${paths.legacyDir}; run plurnk-service paths migrate`);
    }

    static async migrate(paths: HostPaths): Promise<readonly LegacyMigrationMove[]> {
        if (!await exists(paths.legacyDir)) return [];
        const legacyStat = await lstat(paths.legacyDir);
        if (!legacyStat.isDirectory()) throw new Error(`legacy Plurnk home is not a directory: ${paths.legacyDir}`);

        const entries = await readdir(paths.legacyDir, { withFileTypes: true });
        const known = new Set([
            ...CONFIG_MEMBERS.keys(),
            ...DATA_MEMBERS.keys(),
            ...GENERATED_MEMBERS,
            LOCK_MEMBER,
        ]);
        const unknown = entries.filter((entry) => !known.has(entry.name)).map((entry) => entry.name).sort();
        if (unknown.length > 0) {
            throw new Error(`legacy Plurnk home contains unknown member(s): ${unknown.join(", ")}`);
        }
        const nonFiles = entries
            .filter((entry) => !entry.isFile())
            .map((entry) => entry.name)
            .sort();
        if (nonFiles.length > 0) {
            throw new Error(`legacy Plurnk member(s) are not regular files: ${nonFiles.join(", ")}`);
        }
        const existingDestinations = (await Promise.all([
            paths.configDir,
            paths.dataDir,
        ].map(async (path) => await exists(path) ? path : null))).filter((path): path is string => path !== null);
        if (existingDestinations.length > 0) {
            throw new Error(`canonical Plurnk destination(s) already exist: ${existingDestinations.join(", ")}`);
        }

        const names = new Set(entries.map((entry) => entry.name));
        const hasDatabaseState = [...DATA_MEMBERS.keys(), LOCK_MEMBER].some((name) => names.has(name));
        const lock = hasDatabaseState ? await DaemonLock.acquire(join(paths.legacyDir, "plurnk.db")) : null;
        const moves: LegacyMigrationMove[] = [
            ...[...CONFIG_MEMBERS].flatMap(([sourceName, destinationName]) => names.has(sourceName) ? [{
                source: join(paths.legacyDir, sourceName),
                destination: join(paths.configDir, destinationName),
            }] : []),
            ...[...DATA_MEMBERS].flatMap(([sourceName, destinationName]) => names.has(sourceName) ? [{
                source: join(paths.legacyDir, sourceName),
                destination: join(paths.dataDir, destinationName),
            }] : []),
        ];
        const createdDirectories: string[] = [];
        const copied: string[] = [];
        let commitStarted = false;
        try {
            if ([...CONFIG_MEMBERS.keys()].some((name) => names.has(name))) {
                await mkdir(paths.configDir, { recursive: true, mode: 0o700 });
                createdDirectories.push(paths.configDir);
            }
            if ([...DATA_MEMBERS.keys()].some((name) => names.has(name))) {
                await mkdir(paths.dataDir, { recursive: true, mode: 0o700 });
                createdDirectories.push(paths.dataDir);
            }
            // Always copy first, including on one filesystem. Every source stays
            // authoritative until every destination has passed byte verification.
            for (const { source, destination } of moves) {
                await copyVerified(source, destination);
                copied.push(destination);
            }
            for (const { destination } of moves) {
                if (!await exists(destination)) throw new Error(`migration destination verification failed: ${destination}`);
            }
            for (const sourceName of GENERATED_MEMBERS) {
                if (names.has(sourceName)) await unlink(join(paths.legacyDir, sourceName));
            }
            commitStarted = true;
            for (const { source } of moves) await unlink(source);
        } catch (cause) {
            if (!commitStarted) {
                const rollbackErrors: unknown[] = [];
                for (const destination of copied.toReversed()) {
                    try { await unlink(destination); }
                    catch (rollbackCause) {
                        if ((rollbackCause as NodeJS.ErrnoException).code !== "ENOENT") rollbackErrors.push(rollbackCause);
                    }
                }
                for (const directory of createdDirectories.toReversed()) {
                    try { await rmdir(directory); }
                    catch (rollbackCause) {
                        if ((rollbackCause as NodeJS.ErrnoException).code !== "ENOENT") rollbackErrors.push(rollbackCause);
                    }
                }
                if (rollbackErrors.length > 0) {
                    throw new AggregateError([cause, ...rollbackErrors], "legacy path migration failed and rollback was incomplete");
                }
            }
            throw cause;
        } finally {
            await lock?.release();
        }
        const survivors = await readdir(paths.legacyDir);
        if (survivors.length > 0) {
            throw new Error(`legacy Plurnk home was not emptied: ${survivors.join(", ")}`);
        }
        await rmdir(paths.legacyDir);
        return moves;
    }
}
