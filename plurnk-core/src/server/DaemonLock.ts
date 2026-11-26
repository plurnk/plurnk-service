import { isRecord, isSafeInteger } from "@plurnk/plurnk-contracts";
import { readFileSync, readlinkSync } from "node:fs";
import { link, open, readFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";

export interface DaemonStatus {
    readonly pid: number;
    readonly startedAt?: number;
    readonly reloadedAt?: number;
    readonly acpUrl?: string;
    readonly healthUrl?: string;
    readonly auth?: boolean;
    readonly route?: string;
    readonly overrides?: Readonly<Record<string, { readonly value: string; readonly source: string }>>;
    readonly restartRequired?: readonly string[];
}

export interface ProcessIdentityProbe {
    readonly pid: number;
    readonly bootId?: string;
    readonly pidNamespace?: string;
    readonly isPidAlive: (pid: number) => boolean;
    readonly readProcStartTime: (pid: number) => string | undefined;
}

type LockRecord = DaemonStatus & {
    token: string;
    readonly bootId?: string;
    readonly pidNamespace?: string;
    readonly procStartTime?: string;
};

const readHostBootId = (): string | undefined => {
    try {
        const value = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
        return value.length > 0 ? value : undefined;
    } catch {
        return undefined;
    }
};

const readSelfPidNamespace = (): string | undefined => {
    try {
        const value = readlinkSync("/proc/self/ns/pid").trim();
        return value.length > 0 ? value : undefined;
    } catch {
        return undefined;
    }
};

// Linux proc(5) `/proc/<pid>/stat`: field 22 (`starttime`, clock ticks since boot)
// sits at index 19 (0-based) after the final `')'` terminating field 2 (`comm`).
const readProcStartTime = (pid: number): string | undefined => {
    try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const commEnd = stat.lastIndexOf(")");
        if (commEnd < 0) return undefined;
        const fields = stat.slice(commEnd + 2).trim().split(/\s+/u);
        const startTime = fields[19];
        return startTime !== undefined && /^\d+$/u.test(startTime) ? startTime : undefined;
    } catch {
        return undefined;
    }
};

export default class DaemonLock {
    static readonly #heldTokens = new Set<string>();

    readonly #path: string;
    readonly #token: string;
    #released = false;

    private constructor(path: string, token: string) {
        this.#path = path;
        this.#token = token;
    }

    static #defaultProbe(): ProcessIdentityProbe {
        return {
            pid: process.pid,
            bootId: readHostBootId(),
            pidNamespace: readSelfPidNamespace(),
            isPidAlive: DaemonLock.#isAlive,
            readProcStartTime,
        };
    }

    // {§session-causal-admission} {§startup-admission} Determine whether a lockfile's
    // recorded owner is still alive without self-deadlocking on reused PIDs (e.g. PID 1
    // inside a restarted PID namespace/container, #1574) or host reboots.
    static isOwnerAlive(
        owner: Pick<LockRecord, "pid" | "token" | "bootId" | "pidNamespace" | "procStartTime">,
        probe: ProcessIdentityProbe = DaemonLock.#defaultProbe(),
    ): boolean {
        if (DaemonLock.#heldTokens.has(owner.token)) return true;
        if (owner.pid === probe.pid) return false;
        if (owner.bootId !== undefined && probe.bootId !== undefined && owner.bootId !== probe.bootId) {
            return false;
        }
        if (!probe.isPidAlive(owner.pid)) return false;
        if (
            owner.procStartTime !== undefined
            && owner.pidNamespace !== undefined
            && probe.pidNamespace !== undefined
            && owner.pidNamespace === probe.pidNamespace
        ) {
            const liveStartTime = probe.readProcStartTime(owner.pid);
            if (liveStartTime !== undefined && liveStartTime !== owner.procStartTime) return false;
        }
        return true;
    }

    static async acquire(dbPath: string, probe: ProcessIdentityProbe = DaemonLock.#defaultProbe()): Promise<DaemonLock> {
        const path = `${dbPath}.lock`;
        const selfStartTime = probe.readProcStartTime(probe.pid);
        for (;;) {
            const token = randomUUID();
            const tempPath = `${path}.${probe.pid}.${token}.tmp`;
            const handle = await open(tempPath, "wx", 0o600);
            try {
                const record: LockRecord = {
                    pid: probe.pid,
                    startedAt: Date.now(),
                    token,
                    ...(probe.bootId === undefined ? {} : { bootId: probe.bootId }),
                    ...(probe.pidNamespace === undefined ? {} : { pidNamespace: probe.pidNamespace }),
                    ...(selfStartTime === undefined ? {} : { procStartTime: selfStartTime }),
                };
                await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
                await handle.sync();
                await handle.close();
                await link(tempPath, path);
                await unlink(tempPath);
                DaemonLock.#heldTokens.add(token);
                return new DaemonLock(path, token);
            } catch (cause) {
                await handle.close().catch(() => {});
                await unlink(tempPath).catch(() => {});
                if (!DaemonLock.#hasCode(cause, "EEXIST")) throw cause;
                const owner = await DaemonLock.#read(path);
                if (owner !== null && DaemonLock.isOwnerAlive(owner, probe)) {
                    throw new Error(`database is already owned by daemon pid ${owner.pid}: ${dbPath}`);
                }
                await unlink(path).catch((err: unknown) => {
                    if (!DaemonLock.#hasCode(err, "ENOENT")) throw err;
                });
            }
        }
    }

    // {§startup-admission} The live process holding `dbPath`'s lock, or null when none does.
    static async owner(dbPath: string, probe: ProcessIdentityProbe = DaemonLock.#defaultProbe()): Promise<number | null> {
        const owner = await DaemonLock.#read(`${dbPath}.lock`);
        return owner !== null && DaemonLock.isOwnerAlive(owner, probe) ? owner.pid : null;
    }

    static async status(dbPath: string, probe: ProcessIdentityProbe = DaemonLock.#defaultProbe()): Promise<DaemonStatus | null> {
        const owner = await DaemonLock.#read(`${dbPath}.lock`);
        if (owner === null || !DaemonLock.isOwnerAlive(owner, probe)) return null;
        const {
            token: _token,
            bootId: _bootId,
            pidNamespace: _pidNamespace,
            procStartTime: _procStartTime,
            ...status
        } = owner;
        return status;
    }

    static async annotate(dbPath: string, info: Omit<DaemonStatus, "pid">): Promise<void> {
        const path = `${dbPath}.lock`;
        const owner = await DaemonLock.#read(path);
        if (owner === null || owner.pid !== process.pid) return;
        const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
        const handle = await open(tempPath, "wx", 0o600);
        try {
            const record: LockRecord = { ...owner, ...info, pid: owner.pid, token: owner.token };
            await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
            await handle.sync();
            await handle.close();
            await rename(tempPath, path);
        } catch {
            await handle.close().catch(() => {});
            await unlink(tempPath).catch(() => {});
        }
    }

    static alive(pid: number): boolean {
        return DaemonLock.#isAlive(pid);
    }

    async release(): Promise<void> {
        if (this.#released) return;
        this.#released = true;
        DaemonLock.#heldTokens.delete(this.#token);
        const owner = await DaemonLock.#read(this.#path);
        if (owner?.token !== this.#token) return;
        await unlink(this.#path).catch((err: unknown) => {
            if (!DaemonLock.#hasCode(err, "ENOENT")) throw err;
        });
    }

    static async #read(path: string): Promise<LockRecord | null> {
        try {
            const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
            if (!isRecord(parsed) || !isSafeInteger(parsed.pid) || typeof parsed.token !== "string") {
                return null;
            }
            const overrides: Record<string, { value: string; source: string }> | undefined =
                isRecord(parsed.overrides)
                    ? Object.fromEntries(
                        Object.entries(parsed.overrides).flatMap(([k, v]) =>
                            isRecord(v) && typeof v.value === "string" && typeof v.source === "string"
                                ? [[k, { value: v.value, source: v.source }]]
                                : [],
                        ),
                    )
                    : undefined;
            const restartRequired: string[] | undefined = Array.isArray(parsed.restartRequired)
                ? parsed.restartRequired.filter((item): item is string => typeof item === "string")
                : undefined;
            return {
                pid: parsed.pid,
                token: parsed.token,
                ...(typeof parsed.bootId === "string" && parsed.bootId.length > 0 ? { bootId: parsed.bootId } : {}),
                ...(typeof parsed.pidNamespace === "string" && parsed.pidNamespace.length > 0 ? { pidNamespace: parsed.pidNamespace } : {}),
                ...(typeof parsed.procStartTime === "string" && parsed.procStartTime.length > 0 ? { procStartTime: parsed.procStartTime } : {}),
                ...(isSafeInteger(parsed.startedAt) ? { startedAt: parsed.startedAt } : {}),
                ...(isSafeInteger(parsed.reloadedAt) ? { reloadedAt: parsed.reloadedAt } : {}),
                ...(typeof parsed.acpUrl === "string" ? { acpUrl: parsed.acpUrl } : {}),
                ...(typeof parsed.healthUrl === "string" ? { healthUrl: parsed.healthUrl } : {}),
                ...(typeof parsed.auth === "boolean" ? { auth: parsed.auth } : {}),
                ...(typeof parsed.route === "string" ? { route: parsed.route } : {}),
                ...(overrides !== undefined ? { overrides } : {}),
                ...(restartRequired !== undefined ? { restartRequired } : {}),
            };
        } catch (cause) {
            if (DaemonLock.#hasCode(cause, "ENOENT")) return null;
            if (cause instanceof SyntaxError) return null;
            throw cause;
        }
    }

    static #isAlive(pid: number): boolean {
        try {
            process.kill(pid, 0);
            return true;
        } catch (cause) {
            return !DaemonLock.#hasCode(cause, "ESRCH");
        }
    }

    static #hasCode(value: unknown, code: string): boolean {
        return typeof value === "object"
            && value !== null
            && "code" in value
            && (value as { code?: unknown }).code === code;
    }
}
