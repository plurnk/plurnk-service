import fs from "node:fs/promises";
import path from "node:path";
import Meta from "@plurnk/plurnk-meta";
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
// discovery (`@plurnk/plurnk-execs`) the ecosystem standardized on. The shared
// trust predicate is enforced here before any handler import; withheld package
// names return as `skipped` so the consumer can present the decision. Tests and
// unusual layouts pass `packageDirs` explicitly to skip the scan.
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
    const env = options.env ?? process.env;
    const isTrusted = (name: string): boolean => Meta.isTrusted(name, env);

    const byExtension = new Map<string, string>();
    const byFilename = new Map<string, string>();
    const handlers = new Map<string, HandlerInfo>();
    const skipped = new Set<string>();

    for (const dir of dirs) {
        const infos = await readHandlerInfos(dir);
        if (infos.length > 0 && !isTrusted(infos[0].packageName)) {
            skipped.add(infos[0].packageName);
            continue;
        }
        for (const info of infos) {
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
        return { registry, handlers, skipped: [...skipped].sort() };
    }

    for (const entry of TREE_SITTER_REGISTRY) {
        if (handlers.has(entry.mimetype)) continue;
        const info: HandlerInfo = {
            mimetype: entry.mimetype,
            glyph: entry.glyph,
            packageName: `@plurnk/plurnk-mimetypes-grammar-${entry.slug}`,
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
    return { registry, handlers, skipped: [...skipped].sort() };
}

// Enumerate every installed package directory under `<cwd>/node_modules` —
// unscoped (`name`) and scoped (`@scope/name`) alike. `@plurnk` packages are
// returned LAST so first-party handlers win last-loaded collisions (see the
// conflict note on discover()). Non-package entries (`.bin`, `.cache`,
// dotfiles) are skipped. Failures (no node_modules) yield [].
async function defaultPackageDirs(cwd: string): Promise<string[]> {
    const nm = Meta.nearestNodeModules(cwd) ?? path.join(path.resolve(cwd), "node_modules");
    const candidates = await Meta.packageDirs(nm);
    // ORDERING POLICY (ours, not the primitives'): @plurnk packages LAST so first-party
    // handlers win last-loaded collisions — see the conflict note on discover().
    const thirdParty = candidates.filter((c) => !c.name.startsWith("@plurnk/")).map((c) => c.dir).toSorted();
    const plurnk = candidates.filter((c) => c.name.startsWith("@plurnk/")).map((c) => c.dir).toSorted();
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
    if (!Meta.declaresKind(plurnkRec, "mimetype")) return [];
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
        infos.push({
            mimetype: e.name,
            glyph: typeof e.glyph === "string" ? e.glyph : "",
            packageName,
            extensions: filterExtensions(e.extensions),
            binary,
            source: "package",
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
