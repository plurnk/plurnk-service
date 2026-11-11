import Meta from "@plurnk/plurnk-meta";
import type {
    PackageAttributions,
    ExtensionAttribution,
} from "@plurnk/plurnk-meta";

// First-party `@plurnk/*` discovery of installed provider packages
// ({§extension-discovery}).
// Parallel to @plurnk/plurnk-execs' discover(): scan first-party `@plurnk/*`
// packages under `<cwd>/node_modules` and keep the ones declaring
// `plurnk.kind === "provider"`. Non-`@plurnk/*` packages are ignored without
// reading provider fields or importing code.
//
// A provider package maps ONE name → its package specifier (unlike execs, whose
// runtime tags are a per-package array). The name is the alias-cascade provider
// segment (PLURNK_MODEL_<alias>=<name>/<model>). A name collision between two
// installed packages is a FAIL-HARD ambiguity the operator must resolve.
//
// Cataloged and operator-declared providers resolve before this scan.

export type DiscoverOptions = {
    cwd?: string;                  // defaults to process.cwd()
    packageDirs?: string[];        // explicit dirs skip the node_modules scan (tests)
};

// name → package specifier.
export type Discovery = {
    registry: Map<string, string>; // first-party providers, eligible to instantiate
    packageAttributions: PackageAttributions;
};

export const discover = async (options: DiscoverOptions = {}): Promise<Discovery> => {
    const dirs = options.packageDirs ?? await Meta.resolvedPackageDirs(options.cwd ?? process.cwd());

    const registry = new Map<string, string>();
    const packageAttributions = new Map<string, ExtensionAttribution>();
    for (const dir of dirs) {
        const info = await readProviderInfo(dir);
        if (info === null) continue;
        const existing = registry.get(info.name);
        if (existing !== undefined) {
            throw new Error(
                `provider name collision: '${info.name}' claimed by both `
                + `${existing} and ${info.packageName}`,
            );
        }
        const tags = Meta.normalizeAttribution(info.attribution, info.packageName);
        registry.set(info.name, info.packageName);
        if (tags.length > 0) packageAttributions.set(info.packageName, tags);
    }
    return { registry, packageAttributions };
};

// One inert manifest record for a first-party provider package, or null for
// anything that isn't one ({§extension-discovery}).
type ProviderInfo = { name: string; packageName: string; attribution: unknown };

const readProviderInfo = async (dir: string): Promise<ProviderInfo | null> => {
    const manifest = await Meta.readManifest(dir, "provider");
    if (manifest === null) return null;
    const { packageName, plurnk: plurnkRec } = manifest;
    if (typeof plurnkRec.name !== "string" || plurnkRec.name === "") return null;
    return {
        name: plurnkRec.name,
        packageName,
        attribution: plurnkRec.attribution,
    };
};
