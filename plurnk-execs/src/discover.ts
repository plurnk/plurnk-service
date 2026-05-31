import fs from "node:fs/promises";
import path from "node:path";
import type { Discovery, DiscoverOptions, ExecInfo } from "./types.ts";

// Scan installed executor packages and build the runtime-tag registry the
// consuming scheme dispatches on. Parallel to plurnk-mimetypes' discover().
//
// Default scan target: `<cwd>/node_modules/@plurnk/`. Tests and unusual
// layouts can pass `packageDirs` explicitly to skip the scan.
//
// A package is recognized as an executor when its `package.json` declares
// `plurnk.kind === "exec"` and exposes one or more runtime tags via
// `plurnk.runtimes: { name, glyph? }[]` (SPEC §3). Each entry registers its
// tag separately; one package can claim many tags backed by the same handler
// (e.g. the search sibling claims `search`, `news`, `images`, …).
//
// Tags are a flat global namespace. Unlike plurnk-mimetypes (last-loaded
// wins), a tag collision here is a FAIL-HARD install error: two packages
// claiming the same runtime is an unresolvable ambiguity the operator must
// fix (SPEC §3, plurnk-execs#1).
export async function discover(options: DiscoverOptions = {}): Promise<Discovery> {
    const dirs = options.packageDirs ?? await defaultPackageDirs(options.cwd ?? process.cwd());

    const registry = new Map<string, ExecInfo>();
    for (const dir of dirs) {
        for (const info of await readExecInfos(dir)) {
            const existing = registry.get(info.runtime);
            if (existing !== undefined) {
                throw new Error(
                    `exec runtime collision: '${info.runtime}' claimed by both `
                    + `${existing.packageName} and ${info.packageName}`,
                );
            }
            registry.set(info.runtime, info);
        }
    }

    return { registry };
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

// Produce one ExecInfo per declared runtime tag. Returns [] for non-executor
// packages or invalid declarations.
async function readExecInfos(dir: string): Promise<ExecInfo[]> {
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
    if (plurnkRec.kind !== "exec") return [];
    if (!Array.isArray(plurnkRec.runtimes)) return [];

    const packageName = typeof record.name === "string" ? record.name : "";
    const infos: ExecInfo[] = [];
    for (const entry of plurnkRec.runtimes) {
        if (typeof entry !== "object" || entry === null) continue;
        const e = entry as Record<string, unknown>;
        if (typeof e.name !== "string" || e.name === "") continue;
        infos.push({
            runtime: e.name,
            glyph: typeof e.glyph === "string" ? e.glyph : "",
            packageName,
        });
    }

    return infos;
}
