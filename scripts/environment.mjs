// {§environment-layers} — the one statement of how a real-model run is configured. Lowest to highest:
// the service's committed defaults, the operator's file, the committed gate profile; the shell above
// them all and the assembled floor beneath. A launcher takes node flags from here (the last
// `--env-file-if-exists` wins, so the list runs lowest to highest); a script already running applies
// the same layers through `process.loadEnvFile`, which is set-if-unset, so it walks them highest first.
// Plain JavaScript: the candidate launcher imports this and may load no unbuilt source; the operator
// file is HostPaths' to form, so a launcher passes it and a running script asks HostPaths for it.
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repository = resolve(import.meta.dirname, "..");

// The committed real-model gate profile: the posture that is the same on every machine.
export const gateProfile = (root = repository) => join(root, "plurnk-core", ".env.test");

export const floorModule = (root = repository) => join(root, "plurnk-core", "test", "floor.ts");

export const realModelLayers = (root = repository, { operatorFile }) => {
    if (typeof operatorFile !== "string") throw new TypeError("realModelLayers: name the operator file (HostPaths().configFile)");
    return [join(root, "plurnk-core", ".env.defaults"), operatorFile, gateProfile(root)];
};

export const realModelNodeFlags = (root = repository, options) => [
    `--import=${floorModule(root)}`,
    ...realModelLayers(root, options).map((layer) => `--env-file-if-exists=${layer}`),
];

export const applyRealModelEnvironment = async (root = repository, { floor = true, operatorFile } = {}) => {
    const file = operatorFile ?? new (await import(pathToFileURL(join(root, "plurnk-core", "src", "core", "HostPaths.ts")).href)).default().configFile;
    for (const layer of realModelLayers(root, { operatorFile: file }).toReversed()) {
        try { process.loadEnvFile(layer); } catch (cause) { if (cause?.code !== "ENOENT") throw cause; }
    }
    if (floor) await import(pathToFileURL(floorModule(root)).href);
};
