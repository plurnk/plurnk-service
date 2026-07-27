import fs from "node:fs/promises";
import path from "node:path";
import Meta from "@plurnk/plurnk-meta";

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
    // Raw `plurnk.attribution` — the human/org credit a scheme package declares
    // for itself (a name, a handle, a list of contributors). Passed through
    // verbatim (string | string[] | undefined): this package neither validates
    // nor normalizes it; the @plurnk/-tags-only-from-@plurnk/-packages
    // reservation policy is the consumer's to enforce (plurnk-service#26).
    readonly attribution?: string | readonly string[];
}

export interface SchemeDiscoveryResult {
    readonly schemes: ReadonlyArray<SchemeInfo>;
    readonly skipped: ReadonlyArray<string>; // untrusted third-party packages
}

export interface DiscoverOptions {
    readonly cwd?: string;
    readonly packageDirs?: ReadonlyArray<string>; // tests / unusual layouts skip the scan
    readonly signal?: AbortSignal;
}

export default class SchemeDiscovery {
    static async discover(options: DiscoverOptions = {}): Promise<SchemeDiscoveryResult> {
        const { signal } = options;
        const dirs = options.packageDirs ?? await SchemeDiscovery.#defaultPackageDirs(options.cwd ?? process.cwd(), signal);
        const byName = new Map<string, SchemeInfo>();
        const skipped = new Set<string>();
        for (const dir of dirs) {
            signal?.throwIfAborted();
            const infos = await SchemeDiscovery.#readSchemeInfos(dir, signal);
            if (infos.length === 0) continue;
            // Host plugin-trust gate: an untrusted third-party package is
            // discovered but not surfaced for registration — recorded, never
            // crashed on. All of a package's schemes share its packageName, so
            // one trust check gates the whole package.
            if (!Meta.isTrusted(infos[0].packageName)) { skipped.add(infos[0].packageName); continue; }
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
            }
        }
        return { schemes: [...byName.values()], skipped: [...skipped].sort() };
    }

    // Host plugin-trust gate, read from PLURNK_PLUGINS_TRUSTED_ONLY — the SAME
    // env var plurnk-service decides once and every scope-agnostic discovery
    // surface enforces (plurnk-service#229). The ~5-line policy is duplicated,
    // not shared (can't import across the package boundary), matching execs:
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

    // The SchemeInfo(s) for a package declaring plurnk.kind:"scheme"; [] for
    // anything else (non-package dir, non-scheme, no declaration). A package
    // declares EITHER `plurnk.schemes: [{ name, export }, …]` (canonical, one
    // entry per scheme it owns) OR `plurnk.name: "<scheme>"` (sugar for exactly
    // one, default export) — #473. A malformed `plurnk.schemes` is an authoring
    // contract violation and fails hard (locality of error), not a silent skip.
    static async #readSchemeInfos(dir: string, signal?: AbortSignal): Promise<SchemeInfo[]> {
        let raw: string;
        try { raw = await fs.readFile(path.join(dir, "package.json"), { encoding: "utf-8", signal }); }
        catch (err) { if (SchemeDiscovery.#isAbort(err)) throw err; return []; }
        let pkg: unknown;
        try { pkg = JSON.parse(raw); } catch { return []; }
        if (typeof pkg !== "object" || pkg === null) return [];
        const record = pkg as Record<string, unknown>;
        const plurnk = record.plurnk;
        if (typeof plurnk !== "object" || plurnk === null) return [];
        const plurnkRec = plurnk as Record<string, unknown>;
        // is-or-includes (#483): a package owning more than one capability family
        // declares `kind: ["exec", "scheme"]`; the string form stays as the
        // single-kind sugar. A scanner accepts a package whose kind IS or
        // INCLUDES its own.
        const kind = plurnkRec.kind;
        const isScheme = kind === "scheme" || (Array.isArray(kind) && kind.includes("scheme"));
        if (!isScheme) return [];
        if (typeof record.name !== "string" || record.name === "") return [];
        const packageName = record.name;
        const attribution = SchemeDiscovery.#attribution(plurnkRec.attribution);
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

    // Pass `plurnk.attribution` through verbatim when it's a string or an array
    // of strings; anything else (number, object, mixed array) is not credit and
    // is dropped to undefined. No deeper validation — the reservation policy
    // lives in the consumer.
    static #attribution(value: unknown): string | readonly string[] | undefined {
        if (typeof value === "string") return value;
        if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value;
        return undefined;
    }
}
