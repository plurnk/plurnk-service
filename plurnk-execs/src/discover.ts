import fs from "node:fs/promises";
import path from "node:path";
import type { Discovery, DiscoverOptions, ExecInfo } from "./types.ts";

// Scan installed executor packages and build the runtime-tag registry the
// consuming scheme dispatches on. Parallel to plurnk-mimetypes' discover().
//
// Default scan target: every installed package under `<cwd>/node_modules` —
// scope-agnostic, so third-party executors (`@acme/foo`) are discovered too,
// not just `@plurnk/*`. Tests and unusual layouts can pass `packageDirs`
// explicitly to skip the scan.
//
// The PLURNK_PLUGINS_TRUSTED_ONLY gate (plurnk-service#229; see `isTrusted`)
// filters the scope-agnostic scan: when on, an untrusted third-party package is
// discovered but not registered, returned in `Discovery.skipped` for the
// consumer to note. Off by default — no regression.
//
// A package is recognized as an executor when its `package.json` declares
// `plurnk.kind === "exec"` and exposes one or more runtime tags via
// `plurnk.runtimes: { name, glyph?, example?, documentation? }[]` (SPEC §3).
// Each entry registers its tag separately; one package can claim many tags
// backed by the same handler (e.g. the search sibling claims `search`, `news`,
// `images`, …). `example` is a one-line self-documenting usage example for the
// hot-path tools sheet (plurnk-execs#7); `documentation` is the on-demand
// markdown the consumer serves behind `plurnk://execs/<tag>.md`.
//
// Tags are a flat global namespace. Unlike plurnk-mimetypes (last-loaded
// wins), a tag collision here is a FAIL-HARD install error: two packages
// claiming the same runtime is an unresolvable ambiguity the operator must
// fix (SPEC §3, plurnk-execs#1).
export async function discover(options: DiscoverOptions = {}): Promise<Discovery> {
    const dirs = options.packageDirs ?? await defaultPackageDirs(options.cwd ?? process.cwd());

    const registry = new Map<string, ExecInfo>();
    const skipped = new Set<string>();
    for (const dir of dirs) {
        for (const info of await readExecInfos(dir)) {
            // Host plugin-trust gate (plurnk-service#229): an untrusted
            // third-party package is discovered but not registered — recorded
            // for the consumer's telemetry note, never crashed on.
            if (!isTrusted(info.packageName)) {
                skipped.add(info.packageName);
                continue;
            }
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

    return { registry, skipped: [...skipped].sort() };
}

// Host plugin-trust gate, read from PLURNK_PLUGINS_TRUSTED_ONLY — the SAME env
// var plurnk-service decides once and every scope-agnostic discovery surface
// enforces (plurnk-service#229). Mirrors plurnk-service's PluginTrust.isTrusted
// (we can't import across the package boundary, so the ~5-line policy is
// duplicated, not shared):
//   unset / "" / "0" → OFF: every installed package trusted (no regression).
//   any value        → ON:  `@plurnk/*` always trusted, plus a comma-separated
//                           allowlist of additionally-trusted package names;
//                           "1" (naming no real package) = on, zero third-party.
function isTrusted(packageName: string): boolean {
    const gate = process.env.PLURNK_PLUGINS_TRUSTED_ONLY;
    if (gate === undefined || gate === "" || gate === "0") return true;
    if (packageName.startsWith("@plurnk/")) return true;
    return gate.split(",").map((s) => s.trim()).includes(packageName);
}

// Enumerate every installed package directory — scoped (`@scope/name`) and
// unscoped (`name`) — under `<cwd>/node_modules`. The scan is scope-agnostic so
// a THIRD PARTY can publish an executor under their own scope (`@acme/foo`) and
// have it discovered with no involvement from us; `readExecInfos` keeps only the
// packages that declare `plurnk.kind === "exec"`.
async function defaultPackageDirs(cwd: string): Promise<string[]> {
    const nm = path.join(cwd, "node_modules");
    let entries: { name: string; isDirectory(): boolean }[];
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
            example: typeof e.example === "string" ? e.example : "",
            documentation: typeof e.documentation === "string" ? e.documentation : "",
            packageName,
        });
    }

    return infos;
}
