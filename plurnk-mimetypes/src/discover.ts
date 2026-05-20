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
// A package is recognized as a handler when its package.json declares
// `plurnk.kind === "mimetype"` with a string `plurnk.name`. Handlers with
// duplicate mimetype names: last-loaded wins. Handlers with conflicting
// extension entries: last-loaded wins. Plurnk's one-mimetype-per-repo discipline
// means conflicts indicate a real installation problem, not a routine event.
export async function discover(options: DiscoverOptions = {}): Promise<Discovery> {
    const dirs = options.packageDirs ?? await defaultPackageDirs(options.cwd ?? process.cwd());

    const byExtension = new Map<string, string>();
    const byFilename = new Map<string, string>();
    const handlers = new Map<string, HandlerInfo>();

    for (const dir of dirs) {
        const info = await readHandlerInfo(dir);
        if (info === null) continue;

        handlers.set(info.mimetype, info);
        for (const entry of info.extensions) {
            if (entry.startsWith(".")) {
                byExtension.set(entry.toLowerCase(), info.mimetype);
            } else {
                byFilename.set(entry, info.mimetype);
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

async function readHandlerInfo(dir: string): Promise<HandlerInfo | null> {
    const pkgPath = path.join(dir, "package.json");
    let raw: string;
    try {
        raw = await fs.readFile(pkgPath, "utf-8");
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
    if (plurnkRec.kind !== "mimetype") return null;
    if (typeof plurnkRec.name !== "string" || plurnkRec.name === "") return null;

    const rawExt = plurnkRec.extensions;
    const extensions: string[] = Array.isArray(rawExt)
        ? rawExt.filter((e): e is string => typeof e === "string" && e !== "")
        : [];

    const glyph = typeof plurnkRec.glyph === "string" ? plurnkRec.glyph : "";
    const packageName = typeof record.name === "string" ? record.name : "";

    return {
        mimetype: plurnkRec.name,
        glyph,
        packageName,
        extensions,
    };
}
