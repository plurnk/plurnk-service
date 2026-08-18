import type { Db } from "./Db.ts";

// {§worker-settings} — the worker's own behavioral rules inside the workspace's
// world. The workspace says how things are; each worker carries the rules its
// loops obey, declared by the client at worker creation and mutable between
// loops. The bag is validated at the client-input boundary ({§worker-settings});
// readers are permissive — malformed persisted JSON yields the default rules,
// never a read failure.

export interface WorkerSettings {
    readonly requestUserInput: boolean;
}

const DEFAULT_SETTINGS: WorkerSettings = Object.freeze({ requestUserInput: false });

export default class WorkerSettingsReader {
    static async read(db: Db, workerId: number): Promise<WorkerSettings> {
        const row = await db.worker_settings_read.get<{ settings: string }>({ id: workerId });
        if (row === undefined) return DEFAULT_SETTINGS;
        let parsed: unknown;
        try {
            parsed = JSON.parse(row.settings) as unknown;
        } catch {
            return DEFAULT_SETTINGS;
        }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return DEFAULT_SETTINGS;
        const r = parsed as { requestUserInput?: unknown };
        return {
            requestUserInput: r.requestUserInput === true,
        };
    }

    static async requestUserInputEnabled(db: Db, workerId: number): Promise<boolean> {
        return (await WorkerSettingsReader.read(db, workerId)).requestUserInput;
    }
}
