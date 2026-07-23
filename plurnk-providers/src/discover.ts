import fs from "node:fs/promises";
import path from "node:path";
import Meta from "@plurnk/plurnk-meta";

// Scope-agnostic discovery of installed provider packages (SPEC §5, #12/#14).
// Parallel to @plurnk/plurnk-execs' discover(): scan every installed package
// under `<cwd>/node_modules` — scoped (`@scope/name`) and unscoped — and keep
// the ones declaring `plurnk.kind === "provider"`. Scope-agnostic so a THIRD
// PARTY can publish a provider under their own scope (`@acme/llm-provider-foo`)
// and have it discovered with no involvement from us; first-party plugins
// hoist flat via @plurnk/plurnk-providers-all so they land in the same scan.
//
// A provider package maps ONE name → its package specifier (unlike execs, whose
// runtime tags are a per-package array). The name is the alias-cascade provider
// segment (PLURNK_MODEL_<alias>=<name>/<model>). A name collision between two
// installed packages is a FAIL-HARD ambiguity the operator must resolve.
//
// The standard-provider table (./standardProviders.ts) is a separate, closed
// tier-1 resolved before this scan — discovery covers tier 2 (bespoke + third
// party) only. Precedence and standard-name shadowing live in ProviderRegistry.
//
// Host plugin trust gate (PLURNK_PLUGINS_TRUSTED_ONLY, #15 / plurnk-service#229)
// — enforced uniformly across the four scope-agnostic families. An untrusted
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
    // name → raw `plurnk.attribution` (string | string[]) declared by a registered
    // provider package's manifest, for crediting the provider's author (#21,
    // plurnk-service#249). Surfaced verbatim — the consumer applies the reservation
    // policy (`@plurnk/` tags only from `@plurnk/`-scoped packages). Absent for
    // providers that declare none.
    attributions: Map<string, string | string[]>;
};


export const discover = async (options: DiscoverOptions = {}): Promise<Discovery> => {
    const dirs = options.packageDirs ?? await defaultPackageDirs(options.cwd ?? process.cwd());
    const env = options.env ?? process.env;

    const registry = new Map<string, string>();
    const skipped = new Map<string, string>();
    const attributions = new Map<string, string | string[]>();
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
        registry.set(info.name, info.packageName);
        if (info.attribution !== undefined) attributions.set(info.name, info.attribution);
    }
    return { registry, skipped, attributions };
};

// Enumerate every installed package directory — scoped and unscoped — under
// `<cwd>/node_modules`. Unreadable node_modules (e.g. nothing installed) → [].
const defaultPackageDirs = async (cwd: string): Promise<string[]> => {
    const nm = Meta.nearestNodeModules(cwd) ?? path.join(path.resolve(cwd), "node_modules");
    return (await Meta.packageDirs(nm)).map((c) => c.dir).toSorted();
};

// One { name, packageName, attribution? } for a provider package, or null for
// anything that isn't one (missing/invalid package.json, no plurnk block, wrong
// kind, no name). `attribution` mirrors `plurnk.attribution` when it's a string
// or string[] (anything else is ignored).
type ProviderInfo = { name: string; packageName: string; attribution?: string | string[] };

const readProviderInfo = async (dir: string): Promise<ProviderInfo | null> => {
    let raw: string;
    try {
        raw = await fs.readFile(path.join(dir, "package.json"), "utf-8");
    } catch {
        return null;
    }
    let pkg: unknown;
    try {
        pkg = JSON.parse(raw);
    } catch {
        return null;
    }
    if (typeof pkg !== "object" || pkg === null) return null;
    const record = pkg as Record<string, unknown>;
    const plurnk = record.plurnk;
    if (typeof plurnk !== "object" || plurnk === null) return null;
    const plurnkRec = plurnk as Record<string, unknown>;
    if (plurnkRec.kind !== "provider") return null;
    if (typeof plurnkRec.name !== "string" || plurnkRec.name === "") return null;
    if (typeof record.name !== "string" || record.name === "") return null;
    const attr = plurnkRec.attribution;
    const attribution = typeof attr === "string" ? attr
        : Array.isArray(attr) && attr.every((x) => typeof x === "string") ? (attr as string[])
        : undefined;
    return { name: plurnkRec.name, packageName: record.name, attribution };
};
