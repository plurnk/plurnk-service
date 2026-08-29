import { Validator, type CapabilityPolicy } from "@plurnk/plurnk-contracts";
import type { Db } from "./Db.ts";

// {§worker-settings} — the worker's own behavioral rules inside the workspace's
// world. The workspace says how things are; each worker carries the rules its
// loops obey, declared by the client at worker creation and mutable between
// loops. The bag is validated at the client-input boundary ({§worker-settings});
// malformed persistence is an internal contract violation and fails at this
// owner rather than silently widening authority.

export interface WorkerSettings {
    readonly capabilities: CapabilityPolicy;
}

// Root workers begin unrestricted. An adapter that cannot service a class of
// capability narrows the Worker explicitly; Core does not infer one client
// topology as a universal default.
export const DEFAULT_WORKER_CAPABILITIES: CapabilityPolicy = Object.freeze({});

const DEFAULT_SETTINGS: WorkerSettings = Object.freeze({
    capabilities: DEFAULT_WORKER_CAPABILITIES,
});

export default class WorkerSettingsReader {
    static async read(db: Db, workerId: number): Promise<WorkerSettings> {
        const row = await db.worker_settings_read.get<{ settings: string; capability_bound: string }>({ id: workerId });
        if (row === undefined) throw new Error(`Worker ${workerId} does not exist while reading its settings.`);
        let parsed: unknown;
        try {
            parsed = JSON.parse(row.settings) as unknown;
        } catch (cause) {
            throw new Error(`Worker ${workerId} has invalid persisted settings JSON.`, { cause });
        }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            throw new Error(`Worker ${workerId} has invalid persisted settings.`, {
                cause: new TypeError("Persisted Worker settings must be a JSON object."),
            });
        }
        const capabilities = (parsed as { capabilities?: unknown }).capabilities ?? DEFAULT_SETTINGS.capabilities;
        try {
            return { capabilities: Validator.assertCapabilityPolicy(capabilities as CapabilityPolicy) };
        } catch (cause) {
            throw new Error(`Worker ${workerId} has invalid persisted capability policy.`, { cause });
        }
    }

    static async bound(db: Db, workerId: number): Promise<CapabilityPolicy> {
        const row = await db.worker_settings_read.get<{ settings: string; capability_bound: string }>({ id: workerId });
        if (row === undefined) throw new Error(`Worker ${workerId} does not exist while reading its capability bound.`);
        let parsed: unknown;
        try {
            parsed = JSON.parse(row.capability_bound) as unknown;
        } catch (cause) {
            throw new Error(`Worker ${workerId} has invalid persisted capability bound JSON.`, { cause });
        }
        try {
            return Validator.assertCapabilityPolicy(parsed as CapabilityPolicy);
        } catch (cause) {
            throw new Error(`Worker ${workerId} has invalid persisted capability bound.`, { cause });
        }
    }
}
