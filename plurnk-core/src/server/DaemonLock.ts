import { link, open, readFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";

type LockRecord = {
    pid: number;
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
                const record: LockRecord = { pid: process.pid, token };
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
            const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<LockRecord>;
            return Number.isInteger(parsed.pid) && typeof parsed.token === "string"
                ? { pid: parsed.pid as number, token: parsed.token }
                : null;
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
