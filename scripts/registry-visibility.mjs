import { setTimeout as sleep } from "node:timers/promises";

export const REGISTRY_VISIBILITY_ATTEMPTS = 30;
export const REGISTRY_VISIBILITY_INTERVAL_MS = 10_000;

export const awaitRegistryVersion = async ({
    name,
    version,
    lookup,
    subject = name,
    attempts = REGISTRY_VISIBILITY_ATTEMPTS,
    intervalMs = REGISTRY_VISIBILITY_INTERVAL_MS,
    wait = sleep,
}) => {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        if (await lookup(name) === version) return;
        if (attempt < attempts) await wait(intervalMs);
    }
    throw new Error(
        `${subject}: published but the registry never served ${version} within the poll budget — do NOT announce`,
    );
};
