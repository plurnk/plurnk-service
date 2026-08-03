import fs from "node:fs/promises";
import path from "node:path";
import Meta from "@plurnk/plurnk-meta";
import MimetypePluginError from "./MimetypePluginError.ts";
import { TREE_SITTER_REGISTRY } from "./treesitter/registry.ts";
import type {
    Discovery,
    DiscoverOptions,
    HandlerInfo,
    Registry,
} from "./types.ts";

// Scan installed handler packages and build the registry that detect() consumes
// and the orchestrator uses to instantiate handlers.
//
// {§mimetype-discovery} Scope-agnostic scan of `<cwd>/node_modules`, keyed on
// `plurnk.kind === "mimetype"`. The shared trust predicate runs before handler
// import; withheld package names return as `skipped` for consumer presentation.
// Tests and unusual layouts may provide package directories explicitly.
//
// Exact `plurnk.kind === "mimetype"` enters this plugin family. Once trusted,
// the package must expose one or more peer entries through
// `plurnk.handlers: HandlerDecl[]` ({§mimetype-plugin-failure}). Each entry
// produces its own HandlerInfo and routing-map registration. Detection returns
// the matched name, which flows through to `ProcessResult.mimetype`.
//
// Conflicts (two packages claiming the same mimetype name or extension):
// last-loaded wins, and `@plurnk` is scanned LAST so a first-party (floor)
// handler wins a collision — a third party can ADD a new mimetype but cannot
// silently shadow a floor handler by claiming its name.
export async function discover(options: DiscoverOptions = {}): Promise<Discovery> {
    const dirs = options.packageDirs ?? await defaultPackageDirs(options.cwd ?? process.cwd());
    const env = options.env ?? process.env;
    const isTrusted = (name: string): boolean => Meta.isTrusted(name, env);

    const byExtension = new Map<string, string>();
    const byFilename = new Map<string, string>();
    const handlers = new Map<string, HandlerInfo>();
    const skipped = new Set<string>();

    for (const dir of dirs) {
        const manifest = await readMimetypeManifest(dir);
        if (manifest === null) continue;
        if (!isTrusted(manifest.packageName)) {
            skipped.add(manifest.packageName);
            continue;
        }
        const infos = readHandlerInfos(manifest);
        for (const info of infos) {
            handlers.set(info.mimetype, info);
            for (const entry of info.extensions) {
                if (entry.startsWith(".")) {
                    byExtension.set(entry.toLowerCase(), info.mimetype);
                } else {
                    byFilename.set(entry, info.mimetype);
                }
            }
        }
    }

    // A package claim suppresses the same tree-sitter mimetype entirely.
    // Otherwise the built-in entry fills only registry keys still unclaimed.
    //
    // Opt-out via `includeTreeSitter: false` — primarily for tests that need
    // a clean baseline. Production code never disables this.
    if (options.includeTreeSitter === false) {
        const registry: Registry = { byExtension, byFilename };
        return { registry, handlers, skipped: [...skipped].sort() };
    }

    for (const entry of TREE_SITTER_REGISTRY) {
        if (handlers.has(entry.mimetype)) continue;
        const info: HandlerInfo = {
            mimetype: entry.mimetype,
            glyph: entry.glyph,
            packageName: `@plurnk/plurnk-mimetypes-grammar-${entry.slug}`,
            extensions: entry.extensions,
            binary: false,
            source: "treesitter",
        };
        handlers.set(entry.mimetype, info);
        for (const ext of entry.extensions) {
            if (ext.startsWith(".")) {
                if (!byExtension.has(ext.toLowerCase())) {
                    byExtension.set(ext.toLowerCase(), entry.mimetype);
                }
            } else {
                if (!byFilename.has(ext)) byFilename.set(ext, entry.mimetype);
            }
        }
    }

    const registry: Registry = { byExtension, byFilename };
    return { registry, handlers, skipped: [...skipped].sort() };
}

// Enumerate every installed package directory under `<cwd>/node_modules` —
// unscoped (`name`) and scoped (`@scope/name`) alike. `@plurnk` packages are
// returned LAST so first-party handlers win last-loaded collisions (see the
// conflict note on discover()). Non-package entries (`.bin`, `.cache`,
// dotfiles) are skipped. Failures (no node_modules) yield [].
async function defaultPackageDirs(cwd: string): Promise<string[]> {
    const nm = Meta.nearestNodeModules(cwd) ?? path.join(path.resolve(cwd), "node_modules");
    const candidates = await Meta.packageDirs(nm);
    // ORDERING POLICY (ours, not the primitives'): @plurnk packages LAST so first-party
    // handlers win last-loaded collisions — see the conflict note on discover().
    const thirdParty = candidates.filter((c) => !c.name.startsWith("@plurnk/")).map((c) => c.dir).toSorted();
    const plurnk = candidates.filter((c) => c.name.startsWith("@plurnk/")).map((c) => c.dir).toSorted();
    return [...thirdParty, ...plurnk];
}

interface MimetypeManifest {
    readonly manifestPath: string;
    readonly packageName: string;
    readonly plurnk: Record<string, unknown>;
}

const PACKAGE_NAME = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/[a-z0-9~-][a-z0-9._~-]*|[a-z0-9~-][a-z0-9._~-]*)$/;
const MEDIA_TYPE_NAME = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/;

function isPackageName(value: unknown): value is string {
    return typeof value === "string"
        && value.length > 0
        && value.length <= 214
        && PACKAGE_NAME.test(value);
}

// Establish a family claim without interpreting executable declaration fields.
// Non-packages and packages outside this family remain out of domain.
async function readMimetypeManifest(dir: string): Promise<MimetypeManifest | null> {
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
    if (!Meta.declaresKind(plurnkRec, "mimetype")) return null;
    if (!isPackageName(record.name)) {
        throw new MimetypePluginError({
            reason: "package name must be a current npm package name",
            packageName: typeof record.name === "string" ? record.name : null,
            manifestPath: pkgPath,
        });
    }
    return { manifestPath: pkgPath, packageName: record.name, plurnk: plurnkRec };
}

// Produce one HandlerInfo per valid entry from one trusted family claim.
function readHandlerInfos(manifest: MimetypeManifest): HandlerInfo[] {
    const { manifestPath, packageName, plurnk } = manifest;
    const fail = (reason: string, mimetype?: string): never => {
        throw new MimetypePluginError({
            reason,
            packageName,
            mimetype,
            manifestPath,
        });
    };
    const handlers = plurnk.handlers;
    if (!Array.isArray(handlers) || handlers.length === 0) {
        fail("plurnk.handlers must be a non-empty array");
    }
    const entries = handlers as unknown[];
    if (plurnk.binary !== undefined && typeof plurnk.binary !== "boolean") {
        fail("plurnk.binary must be a boolean when present");
    }
    // Package-level `binary: true` applies to every handler in the package.
    const binary = plurnk.binary === true;
    // Normalized package-level attribution is copied to every handler; the host owns policy.
    const attribution = normalizeAttribution(plurnk.attribution);

    return entries.map((entry, index) => {
        if (typeof entry !== "object" || entry === null) {
            fail(`plurnk.handlers entry ${index} must be an object`);
        }
        const e = entry as Record<string, unknown>;
        const name = e.name;
        const glyph = e.glyph;
        const extensions = e.extensions;
        if (typeof name !== "string" || !MEDIA_TYPE_NAME.test(name)) {
            fail(`plurnk.handlers entry ${index} must declare a media-type name`, typeof name === "string" ? name : undefined);
        }
        const mimetype = name as string;
        if (glyph !== undefined && typeof glyph !== "string") {
            fail(`plurnk.handlers entry ${index} glyph must be a string`, mimetype);
        }
        if (extensions !== undefined && (
            !Array.isArray(extensions)
            || !extensions.every((extension) => typeof extension === "string" && extension !== "")
        )) {
            fail(`plurnk.handlers entry ${index} extensions must be non-empty strings`, mimetype);
        }
        return {
            mimetype,
            glyph: typeof glyph === "string" ? glyph : "",
            packageName,
            extensions: (extensions ?? []) as string[],
            binary,
            source: "package",
            ...(attribution !== undefined && { attribution }),
        } satisfies HandlerInfo;
    });
}

// Normalize the pass-through shape without imposing host attribution policy.
function normalizeAttribution(raw: unknown): string | string[] | undefined {
    if (typeof raw === "string") return raw === "" ? undefined : raw;
    if (Array.isArray(raw)) {
        const tags = raw.filter((t): t is string => typeof t === "string" && t !== "");
        return tags.length > 0 ? tags : undefined;
    }
    return undefined;
}
