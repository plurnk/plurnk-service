import fs from "node:fs/promises";
import path from "node:path";

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
// and must never import a scheme package (that would nest daughters under the
// framework and break the top-level scan). The consumer imports each
// `packageName` and registers `new mod.default()` — exactly as the exec scheme
// loads executor packages from plurnk-execs' ExecInfo.
//
// The PLURNK_PLUGINS_TRUSTED_ONLY gate (plurnk-service#229) filters the scan:
// when on, an untrusted third-party package is discovered but withheld from
// `schemes` and returned in `skipped` for the consumer's telemetry note.

export interface SchemeInfo {
    readonly name: string;        // declared plurnk.name — the URI prefix
    readonly packageName: string; // the npm package to import for the handler
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
            const info = await SchemeDiscovery.#readSchemeInfo(dir, signal);
            if (info === null) continue;
            // Host plugin-trust gate: an untrusted third-party package is
            // discovered but not surfaced for registration — recorded, never crashed on.
            if (!SchemeDiscovery.#isTrusted(info.packageName)) { skipped.add(info.packageName); continue; }
            const existing = byName.get(info.name);
            // Two EXTERNAL packages claiming one scheme prefix is an unresolvable
            // ambiguity — fail-hard, mirroring execs' runtime-collision rule.
            // (In-tree precedence is the consumer's concern; it sees its own set.)
            if (existing !== undefined) {
                throw new Error(
                    `scheme name collision: '${info.name}' claimed by both `
                    + `${existing.packageName} and ${info.packageName}`,
                );
            }
            byName.set(info.name, info);
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
    static #isTrusted(packageName: string): boolean {
        const gate = process.env.PLURNK_PLUGINS_TRUSTED_ONLY;
        if (gate === undefined || gate === "" || gate === "0") return true;
        if (packageName.startsWith("@plurnk/")) return true;
        return gate.split(",").map((s) => s.trim()).includes(packageName);
    }

    // Enumerate every installed package directory — scoped (`@scope/name`) and
    // unscoped (`name`) — under `<cwd>/node_modules`. Unreadable dirs are the
    // legitimate scan boundary (not-a-package, missing manifest), skipped — not
    // a masked contract violation (cf. the matcher's sanctioned node_modules tolerance).
    static async #defaultPackageDirs(cwd: string, signal?: AbortSignal): Promise<string[]> {
        signal?.throwIfAborted();
        const nm = path.join(cwd, "node_modules");
        let entries: Array<{ name: string; isDirectory(): boolean }>;
        // fs.readdir takes no AbortSignal — cancellation is checked at the loop
        // boundaries instead (signal-on-fs is reserved for readFile, below).
        try { entries = await fs.readdir(nm, { withFileTypes: true }); } catch { return []; }
        const dirs: string[] = [];
        for (const entry of entries) {
            if (!entry.isDirectory() || entry.name === ".bin" || entry.name === ".cache") continue;
            if (entry.name.startsWith("@")) {
                signal?.throwIfAborted();
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

    // An aborted readFile surfaces, never masked as an unreadable dir —
    // cancellation is a caller contract, not a scan boundary (locality of error).
    static #isAbort(err: unknown): boolean {
        return err instanceof Error && err.name === "AbortError";
    }

    // One SchemeInfo for a package declaring plurnk.kind:"scheme" + plurnk.name;
    // null for anything else (non-package dir, non-scheme, invalid declaration).
    static async #readSchemeInfo(dir: string, signal?: AbortSignal): Promise<SchemeInfo | null> {
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
        if (plurnkRec.kind !== "scheme") return null;
        if (typeof plurnkRec.name !== "string" || plurnkRec.name === "") return null;
        if (typeof record.name !== "string" || record.name === "") return null;
        const attribution = SchemeDiscovery.#attribution(plurnkRec.attribution);
        // Only carry the key when credit is actually present — an absent
        // attribution leaves the property off entirely (not `undefined`), so a
        // no-attribution descriptor stays `{ name, packageName }`.
        return attribution === undefined
            ? { name: plurnkRec.name, packageName: record.name }
            : { name: plurnkRec.name, packageName: record.name, attribution };
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
