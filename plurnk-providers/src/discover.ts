import fs from "node:fs/promises";
import path from "node:path";

// Scope-agnostic discovery of installed provider packages (SPEC §5, #12/#14).
// Parallel to @plurnk/plurnk-execs' discover(): scan every installed package
// under `<cwd>/node_modules` — scoped (`@scope/name`) and unscoped — and keep
// the ones declaring `plurnk.kind === "provider"`. Scope-agnostic so a THIRD
// PARTY can publish a provider under their own scope (`@acme/llm-provider-foo`)
// and have it discovered with no involvement from us; first-party daughters
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
};

// OFF (unset/empty/"0") → every installed provider is trusted (no regression).
// ON (any value) → `@plurnk/*` always trusted, plus a comma-separated allowlist
// of additionally-trusted package names ("1" = on with zero third-party).
const isTrusted = (packageName: string, env: NodeJS.ProcessEnv): boolean => {
    const gate = env.PLURNK_PLUGINS_TRUSTED_ONLY;
    if (gate === undefined || gate === "" || gate === "0") return true;
    if (packageName.startsWith("@plurnk/")) return true;
    return gate.split(",").map((s) => s.trim()).includes(packageName);
};

export const discover = async (options: DiscoverOptions = {}): Promise<Discovery> => {
    const dirs = options.packageDirs ?? await defaultPackageDirs(options.cwd ?? process.cwd());
    const env = options.env ?? process.env;

    const registry = new Map<string, string>();
    const skipped = new Map<string, string>();
    for (const dir of dirs) {
        const info = await readProviderInfo(dir);
        if (info === null) continue;
        if (!isTrusted(info.packageName, env)) {
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
    }
    return { registry, skipped };
};

// Enumerate every installed package directory — scoped and unscoped — under
// `<cwd>/node_modules`. Unreadable node_modules (e.g. nothing installed) → [].
const defaultPackageDirs = async (cwd: string): Promise<string[]> => {
    const nm = path.join(cwd, "node_modules");
    let entries: Array<{ name: string; isDirectory(): boolean }>;
    try {
        entries = await fs.readdir(nm, { withFileTypes: true });
    } catch {
        return [];
    }
    const dirs: string[] = [];
    for (const entry of entries) {
        if (!entry.isDirectory() || entry.name === ".bin" || entry.name === ".cache") continue;
        if (entry.name.startsWith("@")) {
            const scopeDir = path.join(nm, entry.name);
            try {
                const scoped = await fs.readdir(scopeDir, { withFileTypes: true });
                for (const s of scoped) if (s.isDirectory()) dirs.push(path.join(scopeDir, s.name));
            } catch { /* unreadable scope dir — skip */ }
        } else {
            dirs.push(path.join(nm, entry.name));
        }
    }
    return dirs;
};

// One { name, packageName } for a provider package, or null for anything that
// isn't one (missing/invalid package.json, no plurnk block, wrong kind, no name).
type ProviderInfo = { name: string; packageName: string };

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
    return { name: plurnkRec.name, packageName: record.name };
};
