import fs from "node:fs/promises";
import path from "node:path";
import Meta from "@plurnk/plurnk-meta";
import type {
    PackageAttributions,
    PluginAttribution,
    PluginAttributionDeclaration,
} from "@plurnk/plurnk-meta";
import type { GrammarStyle } from "./AiSdkProvider.ts";

// Scope-agnostic discovery of installed AI SDK provider packages
// ({§plugin-family-kind}).
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
// {§plugin-trust-boundary} Host plugin trust gate (PLURNK_PLUGINS_TRUSTED_ONLY)
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
    // Published name-keyed projection retained for 1.x consumers.
    attributions: Map<string, string | string[]>;
    packageAttributions: PackageAttributions;
    // {§provider-grammar-transport} — plugin-declared constrained-decoding
    // capability per provider name; "none" unless the manifest declares one.
    grammarStyles: Map<string, GrammarStyle>;
};


export const discover = async (options: DiscoverOptions = {}): Promise<Discovery> => {
    const dirs = options.packageDirs ?? await defaultPackageDirs(options.cwd ?? process.cwd());
    const env = options.env ?? process.env;

    const registry = new Map<string, string>();
    const skipped = new Map<string, string>();
    const attributions = new Map<string, PluginAttributionDeclaration>();
    const packageAttributions = new Map<string, PluginAttribution>();
    const grammarStyles = new Map<string, GrammarStyle>();
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
        grammarStyles.set(info.name, info.grammarStyle);
        const attribution = attributionProjection(info.attribution, tags);
        if (attribution !== undefined) attributions.set(info.name, attribution);
        if (tags.length > 0) packageAttributions.set(info.packageName, tags);
    }
    return { registry, skipped, attributions, packageAttributions, grammarStyles };
};

// Enumerate every installed package directory — scoped and unscoped — under
// `<cwd>/node_modules`. Unreadable node_modules (e.g. nothing installed) → [].
const defaultPackageDirs = async (cwd: string): Promise<string[]> => {
    const nm = Meta.nearestNodeModules(cwd) ?? path.join(path.resolve(cwd), "node_modules");
    return (await Meta.packageDirs(nm)).map((c) => c.dir).toSorted();
};

// One inert manifest record for a provider package, or null for anything that
// isn't one. Attribution remains unknown until trust admission, then the shared
// {§plugin-attribution} boundary validates it.
type ProviderInfo = { name: string; packageName: string; attribution: unknown; grammarStyle: GrammarStyle };

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
    if (!Meta.declaresKind(plurnkRec, "provider")) return null;
    if (typeof plurnkRec.name !== "string" || plurnkRec.name === "") return null;
    if (typeof record.name !== "string" || record.name === "") return null;
    const grammarStyle = plurnkRec.grammarStyle;
    if (grammarStyle !== undefined && grammarStyle !== "none" && grammarStyle !== "llamacpp") {
        throw new Error(
            `${record.name}: plurnk.grammarStyle must be "none" or "llamacpp", got ${JSON.stringify(grammarStyle)}.`,
        );
    }
    return {
        name: plurnkRec.name,
        packageName: record.name,
        attribution: plurnkRec.attribution,
        grammarStyle: grammarStyle === undefined ? "none" : grammarStyle,
    };
};

const attributionProjection = (
    raw: unknown,
    tags: PluginAttribution,
): PluginAttributionDeclaration | undefined => {
    if (raw === undefined || raw === null) return undefined;
    return typeof raw === "string" ? raw : [...tags];
};
