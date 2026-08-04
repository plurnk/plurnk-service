import fs from "node:fs/promises";
import path from "node:path";
import Meta from "@plurnk/plurnk-meta";
import type {
    PackageAttributions,
    PluginAttribution,
    PluginAttributionDeclaration,
} from "@plurnk/plurnk-meta";

// Scope-agnostic discovery of installed scheme-handler packages — the schemes
// family's parallel to plurnk-execs' discover() / plurnk-mimetypes' discover()
// / plurnk-providers' ProviderRegistry scan. Lives HERE (the contract package),
// co-located with its tests, so the discovery story is self-contained per
// family rather than hand-rolled in the consumer.
//
// A package is a scheme handler when its package.json declares
// `plurnk.kind === "scheme"` and a non-empty `plurnk.name` (the URI prefix it
// claims). The scan is scope-agnostic: it walks EVERY installed package under
// `<cwd>/node_modules` — `@plurnk/*`, third-party scopes (`@acme/foo`), and
// unscoped — so an operator-installed third-party scheme is found with zero
// first-party involvement (plurnk-service#227).
//
// Returns DESCRIPTORS, not instantiated handlers: this package is contract-only
// and must never import a scheme package (that would nest plugins under the
// framework and break the top-level scan). The consumer imports each
// `packageName` and registers `new mod.default()` — exactly as the exec scheme
// loads executor packages from plurnk-execs' ExecInfo.
//
// The PLURNK_PLUGINS_TRUSTED_ONLY gate (plurnk-service#229) filters the scan:
// when on, an untrusted third-party package is discovered but withheld from
// `schemes` and returned in `skipped` for the consumer's Notice.

export interface SchemeInfo {
    readonly name: string;        // declared scheme name — the URI prefix
    readonly packageName: string; // the npm package to import for the handler
    // Which export of `packageName` is the handler class. Absent → `"default"`
    // (the single-scheme `plurnk.name` sugar): the consumer instantiates
    // `mod[exportName ?? "default"]`. A multi-scheme package (`plurnk.schemes`)
    // names one export per scheme, so a package may own several names — one class
    // per name, one NAME still one owner (#473).
    readonly exportName?: string;
    // Published per-scheme projection of the package declaration. Discovery
    // validates it through {§plugin-attribution} before admission.
    readonly attribution?: string | readonly string[];
}

export interface SchemeDiscoveryResult {
    readonly schemes: ReadonlyArray<SchemeInfo>;
    readonly packageAttributions: PackageAttributions;
    readonly skipped: ReadonlyArray<string>; // untrusted third-party packages
}

export interface DiscoverOptions {
    readonly cwd?: string;
    readonly packageDirs?: ReadonlyArray<string>; // tests / unusual layouts skip the scan
    readonly signal?: AbortSignal;
}

interface SchemePackage {
    readonly packageName: string;
    readonly plurnk: Record<string, unknown>;
}

export default class SchemeDiscovery {
    static async discover(options: DiscoverOptions = {}): Promise<SchemeDiscoveryResult> {
        const { signal } = options;
        const dirs = options.packageDirs ?? await SchemeDiscovery.#defaultPackageDirs(options.cwd ?? process.cwd(), signal);
        const byName = new Map<string, SchemeInfo>();
        const packageAttributions = new Map<string, PluginAttribution>();
        const skipped = new Set<string>();
        for (const dir of dirs) {
            signal?.throwIfAborted();
            const manifest = await SchemeDiscovery.#readSchemeManifest(dir, signal);
            if (manifest === null) continue;
            // Host plugin-trust gate: an untrusted third-party package is
            // discovered but not surfaced for registration — recorded, never
            // crashed on. Validation of family fields and attribution follows
            // this package-level gate ({§plugin-trust-boundary}).
            if (!Meta.isTrusted(manifest.packageName)) { skipped.add(manifest.packageName); continue; }
            const tags = Meta.normalizeAttribution(manifest.plurnk.attribution, manifest.packageName);
            const attribution = SchemeDiscovery.#attributionProjection(manifest.plurnk.attribution, tags);
            const infos = SchemeDiscovery.#readSchemeInfos(manifest, attribution);
            let admitted = false;
            for (const info of infos) {
                const existing = byName.get(info.name);
                // Two packages (or two entries) claiming one scheme prefix is an
                // unresolvable ambiguity — fail-hard, mirroring execs' runtime-
                // collision rule. One NAME one owner, even as one PACKAGE owns
                // several names. (In-tree precedence is the consumer's concern.)
                if (existing !== undefined) {
                    throw new Error(
                        `scheme name collision: '${info.name}' claimed by both `
                        + `${existing.packageName} and ${info.packageName}`,
                    );
                }
                byName.set(info.name, info);
                admitted = true;
            }
            if (admitted && tags.length > 0) packageAttributions.set(manifest.packageName, tags);
        }
        return { schemes: [...byName.values()], packageAttributions, skipped: [...skipped].sort() };
    }

    // Host plugin-trust gate, read from PLURNK_PLUGINS_TRUSTED_ONLY — the SAME
    // env var plurnk-service decides once and every scope-agnostic discovery
    // surface enforces through the shared Meta contract (plurnk-service#229):
    //   unset / "" / "0" → OFF: every installed package trusted (no regression).
    //   any value        → ON:  `@plurnk/*` always trusted, plus a comma-separated
    //                           allowlist of additionally-trusted package names.

    // Enumerate every installed package directory — scoped (`@scope/name`) and
    // unscoped (`name`) — under `<cwd>/node_modules`. Unreadable dirs are the
    // legitimate scan boundary (not-a-package, missing manifest), skipped — not
    // a masked contract violation (cf. the matcher's sanctioned node_modules tolerance).
    static async #defaultPackageDirs(cwd: string, signal?: AbortSignal): Promise<string[]> {
        signal?.throwIfAborted();
        const nm = Meta.nearestNodeModules(cwd) ?? path.join(path.resolve(cwd), "node_modules");
        return (await Meta.packageDirs(nm)).map((c) => c.dir).toSorted();
    }

    // An aborted readFile surfaces, never masked as an unreadable dir —
    // cancellation is a caller contract, not a scan boundary (locality of error).
    static #isAbort(err: unknown): boolean {
        return err instanceof Error && err.name === "AbortError";
    }

    // The inert manifest for a package declaring plurnk.kind:"scheme"; null for
    // anything else (non-package dir, non-scheme, no declaration). Family field
    // validation happens only after the package trust gate.
    static async #readSchemeManifest(dir: string, signal?: AbortSignal): Promise<SchemePackage | null> {
        let raw: string;
        try { raw = await fs.readFile(path.join(dir, "package.json"), { encoding: "utf-8", signal }); }
        catch (err) { if (SchemeDiscovery.#isAbort(err)) throw err; return null; }
        let pkg: unknown;
        try { pkg = JSON.parse(raw); } catch { return null; }
        if (typeof pkg !== "object" || pkg === null) return null;
        const record = pkg as Record<string, unknown>;
        const plurnk = record.plurnk;
        if (typeof plurnk !== "object" || plurnk === null) return null;
        const plurnkRec = plurnk as Record<string, unknown>;
        if (!Meta.declaresKind(plurnkRec, "scheme")) return null;
        if (typeof record.name !== "string" || record.name === "") return null;
        return { packageName: record.name, plurnk: plurnkRec };
    }

    // The SchemeInfo(s) for an admitted package. A package
    // declares EITHER `plurnk.schemes: [{ name, export }, …]` (canonical, one
    // entry per scheme it owns) OR `plurnk.name: "<scheme>"` (sugar for exactly
    // one, default export) — #473. A malformed `plurnk.schemes` is an authoring
    // contract violation and fails hard (locality of error), not a silent skip.
    static #readSchemeInfos(
        { packageName, plurnk: plurnkRec }: SchemePackage,
        attribution: PluginAttributionDeclaration | undefined,
    ): SchemeInfo[] {
        // Only carry the key when credit is actually present — an absent
        // attribution leaves the property off entirely (not `undefined`).
        const withAttr = (info: SchemeInfo): SchemeInfo => attribution === undefined ? info : { ...info, attribution };

        const declared = plurnkRec.schemes;
        if (declared !== undefined) {
            if (!Array.isArray(declared) || declared.length === 0) {
                throw new Error(`${packageName}: plurnk.schemes must be a non-empty array of { name, export }`);
            }
            return declared.map((entry) => {
                if (typeof entry !== "object" || entry === null) throw new Error(`${packageName}: each plurnk.schemes entry must be an object`);
                const e = entry as Record<string, unknown>;
                if (typeof e.name !== "string" || e.name === "") throw new Error(`${packageName}: a plurnk.schemes entry is missing a non-empty name`);
                if (typeof e.export !== "string" || e.export === "") throw new Error(`${packageName}: plurnk.schemes entry '${e.name}' is missing a non-empty export`);
                return withAttr({ name: e.name, packageName, exportName: e.export });
            });
        }
        if (typeof plurnkRec.name === "string" && plurnkRec.name !== "") {
            return [withAttr({ name: plurnkRec.name, packageName })]; // sugar: single scheme, default export
        }
        return [];
    }

    static #attributionProjection(
        raw: unknown,
        tags: PluginAttribution,
    ): PluginAttributionDeclaration | undefined {
        if (raw === undefined || raw === null) return undefined;
        return typeof raw === "string" ? raw : [...tags];
    }
}
