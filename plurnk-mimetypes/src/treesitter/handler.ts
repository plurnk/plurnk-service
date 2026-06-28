import TreeSitterExtractor, { walkDeepNode } from "../TreeSitterExtractor.ts";
import type { QueryConstructor, TreeSitterParser, TreeSitterTree } from "../TreeSitterExtractor.ts";
import type { HandlerMetadata, MimeRef, MimeSymbol } from "../types.ts";
import { mimetypeSource, type TelemetryEvent } from "../TelemetryEvent.ts";
import type { TreeSitterLanguageEntry, TreeSitterLanguageMapping } from "./registry.ts";

// Bridges a registry entry to a runtime handler. The framework instantiates
// one of these per mimetype lookup. WASM grammar + mapping module are both
// lazy-loaded via the entry's importMapping + dynamic wasmPackage resolve.
//
// Constructed by the framework's handler-routing path; not exported as a
// public class (consumers don't author these — they author per-language
// mapping files in src/treesitter/ via PR to the framework).
export default class TreeSitterLanguageHandler extends TreeSitterExtractor {
    readonly #entry: TreeSitterLanguageEntry;
    #mappingPromise: Promise<TreeSitterLanguageMapping> | null = null;

    constructor(metadata: HandlerMetadata, entry: TreeSitterLanguageEntry) {
        super(metadata);
        this.#entry = entry;
    }

    protected override async loadParser(): Promise<TreeSitterParser> {
        // Dynamic-import web-tree-sitter so the framework doesn't pull it
        // in at module load — only handlers that actually parse pay the
        // cost. Same pattern as antlr4ng peer-dep loading.
        const ts = await import("web-tree-sitter" as string) as {
            Parser: {
                init(): Promise<void>;
                new (): { setLanguage(lang: unknown): void; parse(content: string): unknown };
            };
            Language: {
                load(wasmPath: string): Promise<unknown>;
            };
            Query: QueryConstructor;
        };
        await ts.Parser.init();
        const wasmPath = await resolveWasmPath(this.#entry);
        const lang = await ts.Language.load(wasmPath);
        // Hand the Language + Query ctor to the base so collectRefs() can
        // compile the refs query (issue #26 — one priming impl, not two).
        this.setQueryContext(lang, ts.Query);
        const parser = new ts.Parser();
        parser.setLanguage(lang);
        return parser as unknown as TreeSitterParser;
    }

    // References channel (issue #19). Languages opt in by exporting a
    // refsQuery from their mapping module; the base collectRefs() helper runs
    // it and resolves containers against the same symbols the mapping emits.
    // No query → empty channel. Parse/grammar error policy lives in the base.
    override async references(content: import("../BaseHandler.ts").HandlerContent): Promise<MimeRef[]> {
        if (typeof content !== "string") return [];
        const mapping = await this.#getMappingCached();
        if (mapping.refsQuery === undefined) return [];
        return this.collectRefs(content, mapping.refsQuery, (root, c) => mapping.extract(root, c));
    }

    protected override extractFromTree(_tree: TreeSitterTree, _content: string): MimeSymbol[] {
        // Required by the abstract base but unreachable: this class overrides
        // extractRaw entirely (the mapping module is an async import, so the
        // sync extractFromTree path can't serve it).
        throw new Error("internal: TreeSitterLanguageHandler uses async extractRaw override");
    }

    // Override extractRaw entirely so we can await both the parser and the
    // mapping import in a single coordinated path.
    override async extractRaw(content: import("../BaseHandler.ts").HandlerContent): Promise<MimeSymbol[]> {
        if (typeof content !== "string") return [];
        let parser: TreeSitterParser;
        let mapping: TreeSitterLanguageMapping;
        try {
            // The base's primed-promise parser cache + the lazy mapping import,
            // awaited together.
            [parser, mapping] = await Promise.all([
                this.getParser(),
                this.#getMappingCached(),
            ]);
        } catch (err) {
            // GrammarNotInstalledError propagates so Mimetypes.process() can
            // degrade to text-plain per #14. Other errors route to empty
            // symbols per the long-standing handler error policy.
            if (err instanceof GrammarNotInstalledError) throw err;
            return [];
        }
        let tree: TreeSitterTree | null;
        try {
            tree = parser.parse(content) as TreeSitterTree | null;
            if (!tree) return [];
        } catch {
            return [];
        }
        try {
            return mapping.extract(tree.rootNode, content);
        } catch {
            return [];
        } finally {
            tree.delete?.();
        }
    }

    // Deep-channel walk. Reuses the same primed-promise parser cache so we
    // don't reload WASM per channel; the symbols + deep paths each parse the
    // content once on first invocation, then share the parser.
    //
    // When the mapping module exports its own deepJson() function, we delegate
    // to it instead of walking the AST — used for data formats (YAML, TOML,
    // JSON-shaped) where the algebra-natural deep-json is the parsed value
    // rather than the parse tree.
    override async deepJson(content: import("../BaseHandler.ts").HandlerContent): Promise<unknown> {
        if (typeof content !== "string") return null;
        const mapping = await this.#getMappingCached();
        if (typeof mapping.deepJson === "function") {
            try {
                return await mapping.deepJson(content);
            } catch {
                return null;
            }
        }
        let parser: TreeSitterParser;
        try {
            parser = await this.getParser();
        } catch (err) {
            if (err instanceof GrammarNotInstalledError) throw err;
            return null;
        }
        let tree: TreeSitterTree | null;
        try {
            tree = parser.parse(content) as TreeSitterTree | null;
            if (!tree) return null;
        } catch {
            return null;
        }
        try {
            return walkDeepNode(tree.rootNode);
        } catch {
            return null;
        } finally {
            tree.delete?.();
        }
    }

    #getMappingCached(): Promise<TreeSitterLanguageMapping> {
        if (this.#mappingPromise === null) {
            this.#mappingPromise = this.#entry.importMapping();
        }
        return this.#mappingPromise;
    }
}

// Resolve the WASM grammar file path for a registry entry. Strategy:
//
//   1. Try `@plurnk/plurnk-mimetypes-grammar-{slug}` first. This is our own
//      per-grammar package that ships the WASM pre-built from a pinned
//      upstream commit. Peer-dep clean (declares only web-tree-sitter, no
//      native tree-sitter) so it doesn't conflict with anything else and
//      doesn't invite node-gyp into the dep tree.
//
//   2. Fall back to the upstream tree-sitter-{lang} package via
//      `entry.wasmPackage` for compatibility while consumers transition. If
//      neither resolves, throw a structured GrammarNotInstalledError that
//      plurnk-service can surface as an install hint.
//
// Resolves the wasm file location by walking from package.json — the bare
// wasm path doesn't work as a require.resolve target because most
// tree-sitter packages don't list .wasm in their `exports` map.
async function resolveWasmPath(entry: TreeSitterLanguageEntry): Promise<string> {
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const path = await import("node:path");

    // 1. Prefer the plurnk grammar package.
    const plurnkPackage = `@plurnk/plurnk-mimetypes-grammar-${entry.slug}`;
    try {
        const pkgJsonPath = require.resolve(`${plurnkPackage}/package.json`);
        return path.join(path.dirname(pkgJsonPath), `${entry.slug}.wasm`);
    } catch {
        // Not installed — fall through.
    }

    // 2. Fall back to the upstream package, if the entry still declares one.
    if (entry.wasmPackage !== null && entry.wasmFile !== null) {
        try {
            const pkgJsonPath = require.resolve(`${entry.wasmPackage}/package.json`);
            return path.join(path.dirname(pkgJsonPath), entry.wasmFile);
        } catch {
            // Upstream not installed either.
        }
    }

    // Neither path resolved — surface an actionable error.
    throw new GrammarNotInstalledError(entry, plurnkPackage);
}

// Thrown when neither the preferred plurnk grammar package nor the upstream
// fallback resolves at runtime. Caller (TreeSitterExtractor.extractRaw)
// catches this and routes to the empty-symbols error policy; plurnk-service
// can surface the package name as an install hint.
export class GrammarNotInstalledError extends Error {
    readonly mimetype: string;
    readonly slug: string;
    readonly plurnkPackage: string;

    constructor(entry: TreeSitterLanguageEntry, plurnkPackage: string) {
        super(
            `No grammar installed for ${entry.mimetype}. Install ${plurnkPackage} (or the legacy ${entry.wasmPackage ?? "upstream tree-sitter-*"} package) to enable this language.`,
        );
        this.name = "GrammarNotInstalledError";
        this.mimetype = entry.mimetype;
        this.slug = entry.slug;
        this.plurnkPackage = plurnkPackage;
    }

    // TelemetryEvent envelope. Only thrown under process({strict:true}); the
    // default path degrades instead (a `warn`, surfaced on ProcessResult.
    // telemetry). When a consumer opts into strict, a missing grammar IS the
    // failure — level=`error`. Carries the package name so the consumer can
    // render the same install hint without re-parsing the message.
    toTelemetryEvent(): TelemetryEvent {
        return {
            source: mimetypeSource(this.mimetype),
            kind: "grammar_not_installed",
            level: "error",
            message: this.message,
            position: null,
            mimetype: this.mimetype,
            plurnkPackage: this.plurnkPackage,
        };
    }
}
