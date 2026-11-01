import { isRecord, isSafeInteger } from "@plurnk/plurnk-contracts";
import { link, open, readFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";

export interface DaemonStatus {
    readonly pid: number;
    readonly startedAt?: number;
    readonly acpUrl?: string;
    readonly healthUrl?: string;
    readonly auth?: boolean;
    readonly route?: string;
    readonly overrides?: Readonly<Record<string, { readonly value: string; readonly source: string }>>;
}

type LockRecord = DaemonStatus & {
    token: string;
};

export default class DaemonLock {
    readonly #path: string;
    readonly #token: string;
    #released = false;

    private constructor(path: string, token: string) {
        this.#path = path;
        this.#token = token;
    }

    static async acquire(dbPath: string): Promise<DaemonLock> {
        const path = `${dbPath}.lock`;
        for (;;) {
            const token = randomUUID();
            const tempPath = `${path}.${process.pid}.${token}.tmp`;
            const handle = await open(tempPath, "wx", 0o600);
            try {
                const record: LockRecord = { pid: process.pid, startedAt: Date.now(), token };
                await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
                await handle.sync();
                await handle.close();
                await link(tempPath, path);
                await unlink(tempPath);
                return new DaemonLock(path, token);
            } catch (cause) {
                await handle.close().catch(() => {});
                await unlink(tempPath).catch(() => {});
                if (!DaemonLock.#hasCode(cause, "EEXIST")) throw cause;
                const owner = await DaemonLock.#read(path);
                if (owner !== null && DaemonLock.#isAlive(owner.pid)) {
                    throw new Error(`database is already owned by daemon pid ${owner.pid}: ${dbPath}`);
                }
                await unlink(path).catch((err: unknown) => {
                    if (!DaemonLock.#hasCode(err, "ENOENT")) throw err;
                });
            }
        }
    }

    // {§startup-admission} The live process holding `dbPath`'s lock, or null when none does.
    static async owner(dbPath: string): Promise<number | null> {
        const owner = await DaemonLock.#read(`${dbPath}.lock`);
        return owner !== null && DaemonLock.#isAlive(owner.pid) ? owner.pid : null;
    }

    static async status(dbPath: string): Promise<DaemonStatus | null> {
        const owner = await DaemonLock.#read(`${dbPath}.lock`);
        if (owner === null || !DaemonLock.#isAlive(owner.pid)) return null;
        const { token: _token, ...status } = owner;
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
            return {
                pid: parsed.pid,
                token: parsed.token,
                ...(isSafeInteger(parsed.startedAt) ? { startedAt: parsed.startedAt } : {}),
                ...(typeof parsed.acpUrl === "string" ? { acpUrl: parsed.acpUrl } : {}),
                ...(typeof parsed.healthUrl === "string" ? { healthUrl: parsed.healthUrl } : {}),
                ...(typeof parsed.auth === "boolean" ? { auth: parsed.auth } : {}),
                ...(typeof parsed.route === "string" ? { route: parsed.route } : {}),
                ...(overrides !== undefined ? { overrides } : {}),
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
