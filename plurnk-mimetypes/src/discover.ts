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
// Default scan target: `<cwd>/node_modules/@plurnk/`. Tests and unusual layouts
// can pass `packageDirs` explicitly to skip the scan.
//
// A package is recognized as a handler when its `package.json` declares
// `plurnk.kind === "mimetype"` and exposes one or more handler entries via
// `plurnk.handlers: HandlerDecl[]` (SPEC §2). Each entry — all entries are
// peers — produces its own HandlerInfo with its own metadata, registered
// separately in the routing maps. Detection returns the matched name; the
// matched mimetype is what flows through to `ProcessResult.mimetype`.
//
// Conflicts (two packages claiming the same mimetype name or extension):
// last-loaded wins. Plurnk's "one package = one coherent group of mimetypes"
// discipline means conflicts indicate a real installation problem.
export async function discover(options: DiscoverOptions = {}): Promise<Discovery> {
    const dirs = options.packageDirs ?? await defaultPackageDirs(options.cwd ?? process.cwd());

    const byExtension = new Map<string, string>();
    const byFilename = new Map<string, string>();
    const handlers = new Map<string, HandlerInfo>();

    for (const dir of dirs) {
        const infos = await readHandlerInfos(dir);
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

async function defaultPackageDirs(cwd: string): Promise<string[]> {
    const scope = path.join(cwd, "node_modules", "@plurnk");
    let entries: { name: string; isDirectory(): boolean }[];
    try {
        entries = await fs.readdir(scope, { withFileTypes: true });
    } catch {
        return [];
    }
    return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(scope, entry.name));
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
        });
    }

    return infos;
}

function filterExtensions(raw: unknown): string[] {
    if (!Array.isArray(raw)) return [];
    return raw.filter((e): e is string => typeof e === "string" && e !== "");
}
