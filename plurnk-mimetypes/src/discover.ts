import fs from "node:fs/promises";
import path from "node:path";
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
// `plurnk.handlers: HandlerDecl[]` (canonical; see SPEC §2). The framework also
// accepts a legacy single-handler flat shape (`plurnk.name` + `plurnk.extensions`
// + `plurnk.glyph` at the top level) for backwards compatibility during the
// schema transition.
//
// Each handler entry — primary or otherwise; all entries are equal — produces
// its own HandlerInfo with its own metadata, registered separately in the
// routing maps. Detection returns the matched name; the matched mimetype is
// what flows through to `ProcessResult.mimetype`.
//
// Conflicts (two packages claiming the same mimetype name or extension):
// last-loaded wins. Plurnk's "one package = one logically-coherent group of
// mimetypes" discipline means conflicts indicate a real installation problem.
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

    const packageName = typeof record.name === "string" ? record.name : "";
    const decls = normalizeHandlerDeclarations(plurnkRec);

    return decls.map((decl) => ({
        mimetype: decl.name,
        glyph: decl.glyph,
        packageName,
        extensions: decl.extensions,
    }));
}

interface HandlerDecl {
    name: string;
    glyph: string;
    extensions: string[];
}

// Accept either the canonical `handlers: HandlerDecl[]` shape or the legacy
// flat shape (`name` + `extensions` + `glyph` at the top level, single handler
// only). Invalid entries are filtered out; an empty result means the package
// declares no usable handlers.
function normalizeHandlerDeclarations(plurnk: Record<string, unknown>): HandlerDecl[] {
    if (Array.isArray(plurnk.handlers)) {
        const decls: HandlerDecl[] = [];
        for (const entry of plurnk.handlers) {
            const decl = parseHandlerEntry(entry);
            if (decl !== null) decls.push(decl);
        }
        return decls;
    }

    // Legacy flat shape — exactly one handler, fields at the top level of plurnk.
    if (typeof plurnk.name !== "string" || plurnk.name === "") return [];
    return [{
        name: plurnk.name,
        glyph: typeof plurnk.glyph === "string" ? plurnk.glyph : "",
        extensions: filterExtensions(plurnk.extensions),
    }];
}

function parseHandlerEntry(entry: unknown): HandlerDecl | null {
    if (typeof entry !== "object" || entry === null) return null;
    const e = entry as Record<string, unknown>;
    if (typeof e.name !== "string" || e.name === "") return null;
    return {
        name: e.name,
        glyph: typeof e.glyph === "string" ? e.glyph : "",
        extensions: filterExtensions(e.extensions),
    };
}

function filterExtensions(raw: unknown): string[] {
    if (!Array.isArray(raw)) return [];
    return raw.filter((e): e is string => typeof e === "string" && e !== "");
}
