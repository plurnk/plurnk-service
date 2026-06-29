import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Discovery, DiscoverOptions, ExecInfo, RuntimeDecl } from "./types.ts";

// An exec package's parsed manifest — its name and the `plurnk` block. Read
// once per package so the trust gate can run before tags are materialized.
interface ExecManifest {
    packageName: string;
    plurnk: Record<string, unknown>;
}

// Scan installed executor packages and build the runtime-tag registry the
// consuming scheme dispatches on. Parallel to plurnk-mimetypes' discover().
// The public `discover()` entry (SPEC §3) is re-exported from index.ts over
// `Discover.scan`; static cross-refs use the explicit `Discover.` binding so a
// detached re-export stays callable.
//
// Default scan target: every installed package under `<cwd>/node_modules` —
// scope-agnostic, so third-party executors (`@acme/foo`) are discovered too,
// not just `@plurnk/*`. Tests and unusual layouts can pass `packageDirs`
// explicitly to skip the scan.
//
// The PLURNK_PLUGINS_TRUSTED_ONLY gate (plurnk-service#229; see `#isTrusted`)
// filters the scope-agnostic scan: when on, an untrusted third-party package is
// discovered but not registered, returned in `Discovery.skipped` for the
// consumer to note. Off by default — no regression.
//
// A package is recognized as an executor when its `package.json` declares
// `plurnk.kind === "exec"` and exposes one or more runtime tags. Tags come from
// one of two sources (SPEC §3):
//   - STATIC: `plurnk.runtimes: { name, glyph?, example?, documentation? }[]` —
//     the tags are known at publish time (sh, search, sqlite, …).
//   - DYNAMIC: `plurnk.runtimesModule: "<rel-path>"` — for a package whose tags
//     are per-deployment (the MCP bridge: one tag per configured server). The
//     module's `runtimes` (or default) export is a hook discover() imports and
//     calls at scan time to materialize the decls. Executed only for TRUSTED
//     packages — the trust gate runs first, so an untrusted package's hook is
//     never imported (plurnk-execs#10). A declared-but-broken hook is fail-hard.
// Each decl registers its tag separately; one package can claim many tags
// backed by the same handler (e.g. the search sibling claims `search`, `news`,
// `images`, …). `example` is a one-line self-documenting usage example
// (plurnk-execs#7); `documentation` is the fuller markdown a consumer can serve
// on demand — sourced from a `docs/<tag>.md` file in the package (the docs
// convention), falling back to the inline `documentation` manifest field.
// execs carries both; how they reach the model is the consumer's. Package-level
// `plurnk.attribution` (string | string[]) is surfaced raw on each tag too
// (plurnk-service#249).
//
// Tags are a flat global namespace. Unlike plurnk-mimetypes (last-loaded
// wins), a tag collision here is a FAIL-HARD install error: two packages
// claiming the same runtime is an unresolvable ambiguity the operator must
// fix (SPEC §3, plurnk-execs#1).
export default class Discover {
    static async scan(options: DiscoverOptions = {}): Promise<Discovery> {
        const dirs = options.packageDirs ?? await Discover.#defaultPackageDirs(options.cwd ?? process.cwd());

        const registry = new Map<string, ExecInfo>();
        const skipped = new Set<string>();
        for (const dir of dirs) {
            const manifest = await Discover.#readExecManifest(dir);
            if (manifest === null) continue; // not an exec package
            // Host plugin-trust gate (plurnk-service#229), enforced BEFORE any
            // tag is read or — critically — any dynamic runtimes hook is
            // imported: an untrusted third-party package is discovered but not
            // registered, and its code is never executed. Recorded for the
            // consumer's telemetry note, never crashed on.
            if (!Discover.#isTrusted(manifest.packageName)) {
                skipped.add(manifest.packageName);
                continue;
            }
            for (const info of await Discover.#readExecInfos(dir, manifest)) {
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

    // Host plugin-trust gate, read from PLURNK_PLUGINS_TRUSTED_ONLY — the SAME
    // env var plurnk-service decides once and every scope-agnostic discovery
    // surface enforces (plurnk-service#229). Mirrors plurnk-service's
    // PluginTrust.isTrusted (we can't import across the package boundary, so the
    // ~5-line policy is duplicated, not shared):
    //   unset / "" / "0" → OFF: every installed package trusted (no regression).
    //   any value        → ON:  `@plurnk/*` always trusted, plus a comma-separated
    //                           allowlist of additionally-trusted package names;
    //                           "1" (naming no real package) = on, zero third-party.
    static #isTrusted(packageName: string): boolean {
        const gate = process.env.PLURNK_PLUGINS_TRUSTED_ONLY;
        if (gate === undefined || gate === "" || gate === "0") return true;
        if (packageName.startsWith("@plurnk/")) return true;
        return gate.split(",").map((s) => s.trim()).includes(packageName);
    }

    // Enumerate every installed package directory — scoped (`@scope/name`) and
    // unscoped (`name`) — under `<cwd>/node_modules`. The scan is scope-agnostic
    // so a THIRD PARTY can publish an executor under their own scope (`@acme/foo`)
    // and have it discovered with no involvement from us; `#readExecInfos` keeps
    // only the packages that declare `plurnk.kind === "exec"`.
    static async #defaultPackageDirs(cwd: string): Promise<string[]> {
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

    // Read a package's `package.json` and return its manifest iff it declares
    // `plurnk.kind === "exec"`. Returns null for non-executor packages, a missing
    // or malformed `package.json` — discover() silently skips those (they are not
    // "skipped by trust", just not exec packages).
    static async #readExecManifest(dir: string): Promise<ExecManifest | null> {
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
        if (plurnkRec.kind !== "exec") return null;

        return { packageName: typeof record.name === "string" ? record.name : "", plurnk: plurnkRec };
    }

    // Produce one ExecInfo per declared runtime tag — static `plurnk.runtimes[]`
    // or a dynamic `plurnk.runtimesModule` hook. Returns [] when neither is
    // declared.
    static async #readExecInfos(dir: string, { packageName, plurnk }: ExecManifest): Promise<ExecInfo[]> {
        // Package-level attribution, surfaced raw (plurnk-service#249); every tag
        // of the package carries the same value. The consumer owns the policy.
        const rawAttr = plurnk.attribution;
        const attribution = typeof rawAttr === "string" || Array.isArray(rawAttr) ? rawAttr as string | string[] : undefined;

        const infos: ExecInfo[] = [];
        for (const decl of await Discover.#runtimeDecls(dir, packageName, plurnk)) {
            if (typeof decl !== "object" || decl === null) continue;
            const e = decl as Record<string, unknown>;
            if (typeof e.name !== "string" || e.name === "") continue;
            // `docs/<tag>.md` is the documentation source of truth (the docs
            // convention); the inline `documentation` field is the fallback.
            const inlineDoc = typeof e.documentation === "string" ? e.documentation : "";
            const documentation = await Discover.#readDocFile(dir, e.name) ?? inlineDoc;
            infos.push({
                runtime: e.name,
                glyph: typeof e.glyph === "string" ? e.glyph : "",
                example: typeof e.example === "string" ? e.example : "",
                documentation,
                packageName,
                ...(attribution !== undefined ? { attribution } : {}),
            });
        }

        return infos;
    }

    // Resolve a package's runtime decls. Static `plurnk.runtimes[]` is the common
    // case; `plurnk.runtimesModule` (a relative path) is the dynamic hook for
    // per-deployment tags. Static wins if both are declared. Returns [] when
    // neither is present.
    static async #runtimeDecls(dir: string, packageName: string, plurnk: Record<string, unknown>): Promise<unknown[]> {
        if (Array.isArray(plurnk.runtimes)) return plurnk.runtimes;
        const mod = plurnk.runtimesModule;
        if (typeof mod === "string" && mod !== "") return Discover.#loadDynamicRuntimes(dir, packageName, mod);
        return [];
    }

    // Import a trusted package's runtimes hook and call it. Fail-hard on every
    // failure — an unloadable module, a missing/non-function export, or a
    // non-array return is a contract violation by a trusted package (its own
    // packaging or config), surfaced with the cause, never swallowed. The trust
    // gate in scan() guarantees this only runs for trusted packages.
    static async #loadDynamicRuntimes(dir: string, packageName: string, rel: string): Promise<RuntimeDecl[]> {
        const href = pathToFileURL(path.join(dir, rel)).href;
        let mod: Record<string, unknown>;
        try {
            mod = await import(href);
        } catch (cause) {
            throw new Error(`exec runtimes hook unloadable: ${packageName} -> ${rel}`, { cause });
        }
        const hook = mod.runtimes ?? mod.default;
        if (typeof hook !== "function") {
            throw new Error(`exec runtimes hook invalid: ${packageName} -> ${rel} must export 'runtimes' (or default) as a function`);
        }
        let decls: unknown;
        try {
            decls = await (hook as () => unknown)();
        } catch (cause) {
            throw new Error(`exec runtimes hook threw: ${packageName} -> ${rel}`, { cause });
        }
        if (!Array.isArray(decls)) {
            throw new Error(`exec runtimes hook returned a non-array: ${packageName} -> ${rel}`);
        }
        return decls as RuntimeDecl[];
    }

    // A tag's documentation file under the package's `docs/` folder — the docs
    // convention's source of truth. Returns null when the package ships none.
    static async #readDocFile(dir: string, tag: string): Promise<string | null> {
        try {
            return await fs.readFile(path.join(dir, "docs", `${tag}.md`), "utf-8");
        } catch {
            return null;
        }
    }
}
