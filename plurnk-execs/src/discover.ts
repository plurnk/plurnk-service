import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import Meta from "@plurnk/plurnk-meta";
import Policy from "./policy.ts";
import type { Discovery, DiscoverOptions, ExecInfo, RuntimeDecl } from "./types.ts";

// An exec package's parsed manifest — its name and the `plurnk` block. Read
// once per package so the trust gate can run before tags are materialized.
interface ExecManifest {
    packageName: string;
    plurnk: Record<string, unknown>;
}

// Build the flat runtime-tag registry from installed executor packages
// ({§executor-discovery}). `index.ts` re-exports `Discover.scan` as discover;
// internal calls retain the class binding so that detached export stays usable.
//
// Default scan target: every installed package under `<cwd>/node_modules` —
// scope-agnostic, so third-party executors (`@acme/foo`) are discovered too,
// not just `@plurnk/*`. Tests and unusual layouts can pass `packageDirs`
// explicitly to skip the scan.
//
// Trust precedes executable hooks ({§executor-trust}). A package is recognized
// only when its manifest declares `plurnk.kind === "exec"`; tags come from:
//   - STATIC: `plurnk.runtimes: { name, glyph?, example?, documentation? }[]` —
//     tags known at publish time.
//   - DYNAMIC: `plurnk.runtimesModule: "<export-subpath>"` — a trusted hook that
//     returns deployment-configured declarations ({§executor-dynamic-runtimes}).
// Each decl registers its tag separately; one package can claim many tags
// backed by the same default export. Example, documentation, and attribution
// projection are defined by {§executor-runtime-declaration}.
//
// Tags occupy one flat namespace. Two packages claiming one tag are a fail-hard
// installation ambiguity.
export default class Discover {
    static async scan(options: DiscoverOptions = {}): Promise<Discovery> {
        const dirs = options.packageDirs ?? await Discover.#defaultPackageDirs(options.cwd ?? process.cwd());

        const registry = new Map<string, ExecInfo>();
        const skipped = new Set<string>();
        const disabled = new Set<string>();
        for (const dir of dirs) {
            const manifest = await Discover.#readExecManifest(dir);
            if (manifest === null) continue; // not an exec package
            // Trust is enforced before any dynamic runtime hook is imported
            // ({§executor-trust}).
            if (!Meta.isTrusted(manifest.packageName)) {
                skipped.add(manifest.packageName);
                continue;
            }
            for (const info of await Discover.#readExecInfos(dir, manifest)) {
                // Boot policy removes a tag before registration; consumer-owned
                // layers can reuse the same parser ({§executor-policy}).
                if (!Policy.isEnabled(info.runtime)) {
                    disabled.add(info.runtime);
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

        return { registry, skipped: [...skipped].sort(), disabled: [...disabled].sort() };
    }


    // Enumerate scoped and unscoped packages under the nearest node_modules;
    // `#readExecManifest` retains only declared executor packages.
    static async #defaultPackageDirs(cwd: string): Promise<string[]> {
        const nm = Meta.nearestNodeModules(cwd) ?? path.join(path.resolve(cwd), "node_modules");
        return (await Meta.packageDirs(nm)).map((c) => c.dir).toSorted();
    }

    // Read a package's `package.json` and return its manifest iff it declares
    // the exact `plurnk.kind === "exec"` family identity.
    // Returns null for non-executor packages, a missing or malformed
    // `package.json` — discover() silently skips those (they are not "skipped by
    // trust", just not exec packages).
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
        if (!Meta.declaresKind(plurnkRec, "exec")) return null;

        return { packageName: typeof record.name === "string" ? record.name : "", plurnk: plurnkRec };
    }

    // Produce one ExecInfo per static or dynamic runtime declaration.
    static async #readExecInfos(dir: string, { packageName, plurnk }: ExecManifest): Promise<ExecInfo[]> {
        // Package-level attribution is surfaced raw on every tag
        // ({§executor-runtime-declaration}); every tag of the package carries
        // the same value. The consumer owns the policy.
        const rawAttr = plurnk.attribution;
        const attribution = typeof rawAttr === "string" || Array.isArray(rawAttr) ? rawAttr as string | string[] : undefined;

        const infos: ExecInfo[] = [];
        for (const decl of await Discover.#runtimeDecls(dir, packageName, plurnk)) {
            if (typeof decl !== "object" || decl === null) continue;
            const e = decl as Record<string, unknown>;
            if (typeof e.name !== "string" || e.name === "") continue;
            // A package doc file wins over inline documentation
            // ({§executor-runtime-declaration}).
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

    // Static declarations win over a dynamic export when both are present
    // ({§executor-dynamic-runtimes}).
    static async #runtimeDecls(dir: string, packageName: string, plurnk: Record<string, unknown>): Promise<unknown[]> {
        if (Array.isArray(plurnk.runtimes)) return plurnk.runtimes;
        const mod = plurnk.runtimesModule;
        if (typeof mod === "string" && mod !== "") return Discover.#loadDynamicRuntimes(dir, packageName, mod);
        return [];
    }

    // Import an admitted package's hook through its export map. Hook loading,
    // shape, execution, and result failures are fail-hard
    // ({§executor-dynamic-runtimes}).
    static async #loadDynamicRuntimes(dir: string, packageName: string, rel: string): Promise<RuntimeDecl[]> {
        if (!rel.startsWith("./")) throw new Error(`exec runtimes hook invalid: ${packageName} -> ${rel} must be an export subpath like "./runtimes"`);
        // Self-reference resolution: the subpath resolves through the package's OWN export
        // map anchored at its root — conditions apply (plurnk-dev → src in a workspace
        // checkout; dist when published), and a package needn't be installed to resolve.
        let href: string;
        try {
            const selfRequire = createRequire(path.join(dir, "package.json"));
            href = pathToFileURL(selfRequire.resolve(`${packageName}${rel.slice(1)}`)).href;
        } catch (cause) {
            throw new Error(`exec runtimes hook unloadable: ${packageName} -> ${rel}`, { cause });
        }
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
