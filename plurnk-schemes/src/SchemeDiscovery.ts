import { isRecord } from "@plurnk/plurnk-contracts";
import Meta from "@plurnk/plurnk-meta";
import type { PackageAttributions, ExtensionAttribution } from "@plurnk/plurnk-meta";

// Scope-agnostic discovery of installed scheme-handler packages — the scheme
// framework's parallel to plurnk-execs' discover() / plurnk-mimetypes' discover()
// / plurnk-providers' ProviderRegistry scan. Lives HERE (the contract package),
// co-located with its tests, so the discovery story is self-contained per
// framework rather than hand-rolled in the consumer.
//
// A package is a scheme handler when its package.json declares
// `plurnk.kind === "scheme"` and a non-empty `plurnk.name` (the URI prefix it
// claims). The scan is scope-agnostic: it walks EVERY installed package under
// `<cwd>/node_modules` — `@plurnk/*`, third-party scopes (`@acme/foo`), and
// unscoped — so an operator-installed third-party scheme is found with zero
// first-party involvement ({§scheme-discovery}).
//
// Returns DESCRIPTORS, not instantiated handlers: this package is contract-only
// and must never import a scheme package (that would nest extensions under the
// framework and break the top-level scan). The consumer imports each
// `packageName` and registers `new mod.default()` — exactly as the consumer
// loads executor packages from plurnk-execs' ExecInfo.
//
// {§extension-discovery} PLURNK_EXTENSIONS_TRUSTED_ONLY filters the scan:
// when on, an untrusted third-party package is discovered but withheld from
// `schemes` and returned in `skipped` for the consumer's Notice.

export interface SchemeInfo {
    readonly name: string;        // declared scheme name — the URI prefix
    readonly packageName: string; // the npm package to import for the handler
    // Which export of `packageName` is the handler class. Absent → `"default"`
    // (the single-scheme `plurnk.name` sugar): the consumer instantiates
    // `mod[exportName ?? "default"]`. A multi-scheme package (`plurnk.schemes`)
    // names one export per scheme, so a package may own several names — one class
    // per name, while one name still has exactly one owner ({§scheme-discovery}).
    readonly exportName?: string;
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
        const { admitted, skipped } = await Meta.scanKind("scheme", options);
        const byName = new Map<string, SchemeInfo>();
        const packageAttributions = new Map<string, ExtensionAttribution>();
        for (const pkg of admitted) {
            const infos = SchemeDiscovery.#readSchemeInfos(pkg);
            let pkgAdmitted = false;
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
                pkgAdmitted = true;
            }
            if (pkgAdmitted && pkg.attribution.length > 0) {
                packageAttributions.set(pkg.packageName, pkg.attribution);
            }
        }
        return { schemes: [...byName.values()], packageAttributions, skipped };
    }

    // The SchemeInfo(s) for an admitted package. A package
    // declares EITHER `plurnk.schemes: [{ name, export }, …]` (canonical, one
    // entry per scheme it owns) OR `plurnk.name: "<scheme>"` (sugar for exactly
    // one, default export). A malformed `plurnk.schemes` is an authoring
    // contract violation and fails hard (locality of error), not a silent skip.
    static #readSchemeInfos({ packageName, plurnk: plurnkRec }: SchemePackage): SchemeInfo[] {
        const declared = plurnkRec.schemes;
        if (declared !== undefined) {
            if (!Array.isArray(declared) || declared.length === 0) {
                throw new Error(`${packageName}: plurnk.schemes must be a non-empty array of { name, export }`);
            }
            return declared.map((entry) => {
                if (!isRecord(entry)) throw new Error(`${packageName}: each plurnk.schemes entry must be an object`);
                const e = entry;
                if (typeof e.name !== "string" || e.name === "") throw new Error(`${packageName}: a plurnk.schemes entry is missing a non-empty name`);
                if (typeof e.export !== "string" || e.export === "") throw new Error(`${packageName}: plurnk.schemes entry '${e.name}' is missing a non-empty export`);
                return { name: e.name, packageName, exportName: e.export };
            });
        }
        if (typeof plurnkRec.name === "string" && plurnkRec.name !== "") {
            return [{ name: plurnkRec.name, packageName }]; // sugar: single scheme, default export
        }
        return [];
    }
}
