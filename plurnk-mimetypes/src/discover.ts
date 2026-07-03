import fs from "node:fs/promises";
import path from "node:path";
import { TREE_SITTER_REGISTRY } from "./treesitter/registry.ts";
import type {
    Discovery,
    DiscoverOptions,
    HandlerInfo,
    Registry,
} from "./types.ts";

// Scan installed handler packages and build the registry that detect() consumes
// and the orchestrator uses to instantiate handlers.
//
// Scope-agnostic scan of `<cwd>/node_modules` (issue #28): every installed
// package — unscoped (`name`) and under every scope (`@scope/name`) — keyed on
// `plurnk.kind === "mimetype"`, NOT the `@plurnk` scope. This is the
// third-party enabler: `@acme/acme-mime-foo` is discovered exactly like a
// first-party handler, with zero involvement from us — matching the executor
// discovery (`@plurnk/plurnk-execs`) the ecosystem standardized on. Trust is
// not decided here: discover() is a dumb scanner that returns everything
// installed; the host (plurnk-service) applies any trust policy to these
// results (service#229). Tests and unusual layouts pass `packageDirs`
// explicitly to skip the scan.
//
// A package is recognized as a handler when its `package.json` declares
// `plurnk.kind === "mimetype"` and exposes one or more handler entries via
// `plurnk.handlers: HandlerDecl[]` (SPEC §2). Each entry — all entries are
// peers — produces its own HandlerInfo with its own metadata, registered
// separately in the routing maps. Detection returns the matched name; the
// matched mimetype is what flows through to `ProcessResult.mimetype`.
//
// Conflicts (two packages claiming the same mimetype name or extension):
// last-loaded wins, and `@plurnk` is scanned LAST so a first-party (floor)
// handler wins a collision — a third party can ADD a new mimetype but cannot
// silently shadow a floor handler by claiming its name.
export async function discover(options: DiscoverOptions = {}): Promise<Discovery> {
    const dirs = options.packageDirs ?? await defaultPackageDirs(options.cwd ?? process.cwd());
    const isTrusted = trustPredicate(options.env ?? process.env);

    const byExtension = new Map<string, string>();
    const byFilename = new Map<string, string>();
    const handlers = new Map<string, HandlerInfo>();

    for (const dir of dirs) {
        const infos = await readHandlerInfos(dir);
        for (const info of infos) {
            // Plugin trust gate (#29): an untrusted package is
            // discovered-but-not-registered. Skip silently — surfacing the
            // skip (telemetry) is the host's concern; discover() must never
            // crash on an untrusted package.
            if (!isTrusted(info.packageName)) continue;
            handlers.set(info.mimetype, info);
            for (const entry of info.extensions) {
                if (entry.startsWith(".")) {
                    byExtension.set(entry.toLowerCase(), info.mimetype);
                } else {
                    byFilename.set(entry, info.mimetype);
                }
            }
        }
    }

    // Seed tree-sitter registry entries. @plurnk packages win on conflicts —
    // we only set a mimetype/extension when no @plurnk handler has already
    // claimed it. This means during the deprecation transition, a user with
    // an old @plurnk/plurnk-mimetypes-text-python installed continues to use
    // that handler; once they uninstall it, the framework's built-in tree-
    // sitter entry takes over.
    //
    // Opt-out via `includeTreeSitter: false` — primarily for tests that need
    // a clean baseline. Production code never disables this.
    if (options.includeTreeSitter === false) {
        const registry: Registry = { byExtension, byFilename };
        return { registry, handlers };
    }

    for (const entry of TREE_SITTER_REGISTRY) {
        if (handlers.has(entry.mimetype)) continue;
        const info: HandlerInfo = {
            mimetype: entry.mimetype,
            glyph: entry.glyph,
            packageName: entry.wasmPackage ?? `@plurnk/plurnk-mimetypes-grammar-${entry.slug}`,
            extensions: entry.extensions,
            binary: false,
            source: "treesitter",
        };
        handlers.set(entry.mimetype, info);
        for (const ext of entry.extensions) {
            if (ext.startsWith(".")) {
                if (!byExtension.has(ext.toLowerCase())) {
                    byExtension.set(ext.toLowerCase(), entry.mimetype);
                }
            } else {
                if (!byFilename.has(ext)) byFilename.set(ext, entry.mimetype);
            }
        }
    }

    const registry: Registry = { byExtension, byFilename };
    return { registry, handlers };
}

// Enumerate every installed package directory under `<cwd>/node_modules` —
// unscoped (`name`) and scoped (`@scope/name`) alike. `@plurnk` packages are
// returned LAST so first-party handlers win last-loaded collisions (see the
// conflict note on discover()). Non-package entries (`.bin`, `.cache`,
// dotfiles) are skipped. Failures (no node_modules) yield [].
// Plugin trust gate (issue #29 / plurnk-service#229). Reads
// PLURNK_PLUGINS_TRUSTED_ONLY into a per-package trust predicate, shared
// semantics across all four discovery surfaces:
//   unset / "" / "0"  → gate OFF — everything installed is trusted.
//   any other value   → gate ON — `@plurnk/*` always trusted, plus a
//                        comma-separated allowlist of additionally-trusted
//                        package names. (Setting it to "1", which names no
//                        real package, is "on with zero third-party".)
function trustPredicate(env: Record<string, string | undefined>): (packageName: string) => boolean {
    const raw = env.PLURNK_PLUGINS_TRUSTED_ONLY;
    const value = raw?.trim() ?? "";
    if (value === "" || value === "0") return () => true;
    const allow = new Set(value.split(",").map((s) => s.trim()).filter((s) => s.length > 0));
    return (packageName) => packageName.startsWith("@plurnk/") || allow.has(packageName);
}

async function defaultPackageDirs(cwd: string): Promise<string[]> {
    const nodeModules = path.join(cwd, "node_modules");
    let top: { name: string; isDirectory(): boolean }[];
    try {
        top = await fs.readdir(nodeModules, { withFileTypes: true });
    } catch {
        return [];
    }

    const thirdParty: string[] = [];
    const plurnk: string[] = [];
    for (const entry of top) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        if (entry.name.startsWith("@")) {
            const scopeDir = path.join(nodeModules, entry.name);
            let scoped: { name: string; isDirectory(): boolean }[];
            try {
                scoped = await fs.readdir(scopeDir, { withFileTypes: true });
            } catch {
                continue;
            }
            const target = entry.name === "@plurnk" ? plurnk : thirdParty;
            for (const s of scoped) {
                if (s.isDirectory()) target.push(path.join(scopeDir, s.name));
            }
        } else {
            thirdParty.push(path.join(nodeModules, entry.name));
        }
    }
    thirdParty.sort();
    plurnk.sort();
    return [...thirdParty, ...plurnk];
}

// Produce one HandlerInfo per declared handler entry. Returns [] for
// non-handler packages or invalid declarations.
async function readHandlerInfos(dir: string): Promise<HandlerInfo[]> {
    const pkgPath = path.join(dir, "package.json");
    let raw: string;
    try {
        raw = await fs.readFile(pkgPath, "utf-8");
    } catch {
        return [];
    }

    let pkg: unknown;
    try {
        pkg = JSON.parse(raw);
    } catch {
        return [];
    }

    if (typeof pkg !== "object" || pkg === null) return [];
    const record = pkg as Record<string, unknown>;
    const plurnk = record.plurnk;
    if (typeof plurnk !== "object" || plurnk === null) return [];
    const plurnkRec = plurnk as Record<string, unknown>;
    if (plurnkRec.kind !== "mimetype") return [];
    if (!Array.isArray(plurnkRec.handlers)) return [];

    const packageName = typeof record.name === "string" ? record.name : "";
    // Package-level `binary: true` flag applies to every handler in the
    // package — typical for whole-package binary handlers (PDF, images).
    const binary = plurnkRec.binary === true;
    // Package-level attribution tags (issue #37). Like `binary`, declared once
    // and applied to every handler entry. Pass-through — the host owns policy.
    const attribution = normalizeAttribution(plurnkRec.attribution);
    const infos: HandlerInfo[] = [];

    for (const entry of plurnkRec.handlers) {
        if (typeof entry !== "object" || entry === null) continue;
        const e = entry as Record<string, unknown>;
        if (typeof e.name !== "string" || e.name === "") continue;
        // Optional per-entry navigation declaration (SPEC §20). Only the two
        // legal values pass; anything else is a malformed entry field and the
        // declaration is dropped (the heuristic answers instead) — same
        // dumb-scanner posture as glyph/extensions.
        const navigation = e.navigation === "line" || e.navigation === "tree" ? e.navigation : undefined;
        infos.push({
            mimetype: e.name,
            glyph: typeof e.glyph === "string" ? e.glyph : "",
            packageName,
            extensions: filterExtensions(e.extensions),
            binary,
            source: "package",
            ...(navigation !== undefined && { navigation }),
            ...(attribution !== undefined && { attribution }),
        });
    }

    return infos;
}

// Normalize `plurnk.attribution` to string | string[] | undefined (issue #37).
// A dumb scanner: a single non-empty string passes through; an array is
// filtered to its non-empty strings (undefined if none survive); anything else
// (number, object, "", []) is treated as absent. Validation/reservation policy
// is the host's concern, not ours.
function normalizeAttribution(raw: unknown): string | string[] | undefined {
    if (typeof raw === "string") return raw === "" ? undefined : raw;
    if (Array.isArray(raw)) {
        const tags = raw.filter((t): t is string => typeof t === "string" && t !== "");
        return tags.length > 0 ? tags : undefined;
    }
    return undefined;
}

function filterExtensions(raw: unknown): string[] {
    if (!Array.isArray(raw)) return [];
    return raw.filter((e): e is string => typeof e === "string" && e !== "");
}
