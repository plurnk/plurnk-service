import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import Meta from "@plurnk/plurnk-meta";
import type { ExtensionAttribution, ExtensionAttributionDeclaration } from "@plurnk/plurnk-meta";
import DocFile from "./DocFile.ts";
import Policy from "./policy.ts";
import RuntimeDeclaration from "./RuntimeDeclaration.ts";
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
// Trust precedes executable discovery code ({§executor-trust}). A package is recognized
// only when its manifest declares `plurnk.kind === "exec"`; tags come from:
//   - STATIC: `plurnk.runtimes: { name, glyph?, summary, invocation, details? }[]` —
//     tags known at publish time.
//   - DYNAMIC: `plurnk.runtimesModule: "<export-subpath>"` — a trusted runtimes function that
//     returns deployment-configured declarations ({§executor-dynamic-runtimes}).
// Each decl registers its tag separately; one package can claim many tags
// backed by the same default export. Summary, invocation, details, and attribution
// projection are defined by {§executor-runtime-declaration}.
//
// Tags occupy one flat namespace. Two packages claiming one tag are a fail-hard
// installation ambiguity.
export default class Discover {
    static async scan(options: DiscoverOptions = {}): Promise<Discovery> {
        const dirs = options.packageDirs ?? await Discover.#defaultPackageDirs(options.cwd ?? process.cwd());

        const registry = new Map<string, ExecInfo>();
        const packageAttributions = new Map<string, ExtensionAttribution>();
        const skipped = new Set<string>();
        const disabled = new Set<string>();
        for (const dir of dirs) {
            const manifest = await Discover.#readExecManifest(dir);
            if (manifest === null) continue; // not an exec package
            // Trust is enforced before any dynamic runtimes function is imported
            // ({§executor-trust}).
            if (!Meta.isTrusted(manifest.packageName)) {
                skipped.add(manifest.packageName);
                continue;
            }
            const tags = Meta.normalizeAttribution(manifest.plurnk.attribution, manifest.packageName);
            const attribution = Discover.#attributionProjection(manifest.plurnk.attribution, tags);
            let admitted = false;
            for (const info of await Discover.#readExecInfos(dir, manifest, attribution)) {
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
                admitted = true;
            }
            if (admitted && tags.length > 0) packageAttributions.set(manifest.packageName, tags);
        }

        return { registry, packageAttributions, skipped: [...skipped].sort(), disabled: [...disabled].sort() };
    }


    // Enumerate scoped and unscoped packages under the nearest node_modules;
    // `#readExecManifest` retains only declared executor packages.
    static async #defaultPackageDirs(cwd: string): Promise<string[]> {
        const nm = Meta.nearestNodeModules(cwd) ?? path.join(path.resolve(cwd), "node_modules");
        return (await Meta.packageDirs(nm)).map((c) => c.dir).toSorted();
    }

    // The manifest of a declared executor package ({§extension-manifest-read}); discover() silently
    // skips everything else (not "skipped by trust", just not an exec package).
    static async #readExecManifest(dir: string): Promise<ExecManifest | null> {
        const manifest = await Meta.readManifest(dir, "exec");
        return manifest === null ? null : { packageName: manifest.packageName ?? "", plurnk: manifest.plurnk };
    }

    // Produce one ExecInfo per static or dynamic runtime declaration.
    static async #readExecInfos(
        dir: string,
        { packageName, plurnk }: ExecManifest,
        attribution: ExtensionAttributionDeclaration | undefined,
    ): Promise<ExecInfo[]> {
        const infos: ExecInfo[] = [];
        for (const raw of await Discover.#runtimeDecls(dir, packageName, plurnk)) {
            const decl = RuntimeDeclaration.assert(raw, packageName);
            // A package doc file wins over inline details
            // ({§executor-runtime-declaration}).
            const details = await DocFile.read(dir, decl.name) ?? decl.details ?? "";
            infos.push({
                runtime: decl.name,
                glyph: decl.glyph ?? "",
                summary: decl.summary,
                invocation: decl.invocation,
                details,
                packageName,
                ...(decl.resourcesPath === undefined ? {} : { resourcesPath: decl.resourcesPath }),
                ...(decl.expandTools === undefined ? {} : { expandTools: decl.expandTools }),
                ...(attribution !== undefined ? { attribution } : {}),
            });
        }

        return infos;
    }

    // The package map is canonical. This preserves the shipped descriptor shape
    // without preserving a second validation policy.
    static #attributionProjection(
        raw: unknown,
        tags: ExtensionAttribution,
    ): ExtensionAttributionDeclaration | undefined {
        if (raw === undefined || raw === null) return undefined;
        return typeof raw === "string" ? raw : [...tags];
    }

    // Static declarations win over a dynamic export when both are present
    // ({§executor-dynamic-runtimes}).
    static async #runtimeDecls(dir: string, packageName: string, plurnk: Record<string, unknown>): Promise<unknown[]> {
        if (Array.isArray(plurnk.runtimes)) return plurnk.runtimes;
        const mod = plurnk.runtimesModule;
        if (typeof mod === "string" && mod !== "") return Discover.#loadDynamicRuntimes(dir, packageName, mod);
        return [];
    }

    // Import an admitted package's runtimes function through its export map. Its loading,
    // shape, execution, and result failures are fail-hard
    // ({§executor-dynamic-runtimes}).
    static async #loadDynamicRuntimes(dir: string, packageName: string, rel: string): Promise<RuntimeDecl[]> {
        if (!rel.startsWith("./")) throw new Error(`exec runtimes function invalid: ${packageName} -> ${rel} must be an export subpath like "./runtimes"`);
        // Self-reference resolution: the subpath resolves through the package's OWN export
        // map anchored at its root — conditions apply (plurnk-dev → src in a workspace
        // checkout; dist when published), and a package needn't be installed to resolve.
        let href: string;
        try {
            const selfRequire = createRequire(path.join(dir, "package.json"));
            href = pathToFileURL(selfRequire.resolve(`${packageName}${rel.slice(1)}`)).href;
        } catch (cause) {
            throw new Error(`exec runtimes function unloadable: ${packageName} -> ${rel}`, { cause });
        }
        let mod: Record<string, unknown>;
        try {
            mod = await import(href);
        } catch (cause) {
            throw new Error(`exec runtimes function unloadable: ${packageName} -> ${rel}`, { cause });
        }
        const runtimes = mod.runtimes ?? mod.default;
        if (typeof runtimes !== "function") {
            throw new Error(`exec runtimes function invalid: ${packageName} -> ${rel} must export 'runtimes' (or default) as a function`);
        }
        let decls: unknown;
        try {
            decls = await (runtimes as () => unknown)();
        } catch (cause) {
            throw new Error(`exec runtimes function threw: ${packageName} -> ${rel}`, { cause });
        }
        if (!Array.isArray(decls)) {
            throw new Error(`exec runtimes function returned a non-array: ${packageName} -> ${rel}`);
        }
        return decls as RuntimeDecl[];
    }
}
