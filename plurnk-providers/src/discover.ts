import Meta from "@plurnk/plurnk-meta";
import type {
    PackageAttributions,
    ExtensionAttribution,
} from "@plurnk/plurnk-meta";

// Scope-agnostic discovery of installed provider packages
// ({§extension-discovery}).
// Parallel to @plurnk/plurnk-execs' discover(): scan every installed package
// under `<cwd>/node_modules` — scoped (`@scope/name`) and unscoped — and keep
// the ones declaring `plurnk.kind === "provider"`. Scope-agnostic so a THIRD
// PARTY can publish a provider under their own scope (`@acme/llm-provider-foo`)
// and have it discovered without involvement from PLURNK.
//
// A provider package maps ONE name → its package specifier (unlike execs, whose
// runtime tags are a per-package array). The name is the alias-cascade provider
// segment (PLURNK_MODEL_<alias>=<name>/<model>). A name collision between two
// installed packages is a FAIL-HARD ambiguity the operator must resolve.
//
// Cataloged and operator-declared providers resolve before this scan.
//
// {§extension-discovery} Host extension trust gate (PLURNK_EXTENSIONS_TRUSTED_ONLY)
// — enforced uniformly across the four scope-agnostic kinds. An untrusted
// package is discovered-but-declined (recorded in `skipped`, never registered,
// never thrown), so the consumer can name it in a precise error.

export type DiscoverOptions = {
    cwd?: string;                  // defaults to process.cwd()
    packageDirs?: string[];        // explicit dirs skip the node_modules scan (tests)
    env?: NodeJS.ProcessEnv;       // trust-gate env; defaults to process.env
};

// name → package specifier, split by the trust decision.
export type Discovery = {
    registry: Map<string, string>; // trusted providers, eligible to instantiate
    skipped: Map<string, string>;  // declined by the trust gate (untrusted)
    packageAttributions: PackageAttributions;
};


export const discover = async (options: DiscoverOptions = {}): Promise<Discovery> => {
    const dirs = options.packageDirs ?? await Meta.resolvedPackageDirs(options.cwd ?? process.cwd());
    const env = options.env ?? process.env;

    const registry = new Map<string, string>();
    const skipped = new Map<string, string>();
    const packageAttributions = new Map<string, ExtensionAttribution>();
    for (const dir of dirs) {
        const info = await readProviderInfo(dir);
        if (info === null) continue;
        if (!Meta.isTrusted(info.packageName, env)) {
            skipped.set(info.name, info.packageName); // declined — not a collision candidate
            continue;
        }
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
    return { registry, skipped, packageAttributions };
};

// One inert manifest record for a provider package, or null for anything that
// isn't one. Attribution remains unknown until trust admission, then the shared
// {§extension-discovery} boundary validates it.
type ProviderInfo = { name: string; packageName: string; attribution: unknown };

const readProviderInfo = async (dir: string): Promise<ProviderInfo | null> => {
    const manifest = await Meta.readManifest(dir, "provider");
    if (manifest === null || manifest.packageName === null) return null;
    const { packageName, plurnk: plurnkRec } = manifest;
    if (typeof plurnkRec.name !== "string" || plurnkRec.name === "") return null;
    return {
        name: plurnkRec.name,
        packageName,
        attribution: plurnkRec.attribution,
    };
};
