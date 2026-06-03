import TreeSitterExtractor, { walkDeepNode } from "../TreeSitterExtractor.ts";
import type { TreeSitterParser, TreeSitterTree } from "../TreeSitterExtractor.ts";
import type { HandlerMetadata, MimeSymbol } from "../types.ts";
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
        };
        await ts.Parser.init();
        const wasmPath = await resolveWasmPath(this.#entry);
        const lang = await ts.Language.load(wasmPath);
        const parser = new ts.Parser();
        parser.setLanguage(lang);
        return parser as unknown as TreeSitterParser;
    }

    protected override extractFromTree(tree: TreeSitterTree, content: string): MimeSymbol[] {
        // The mapping module is lazy too — first call awaits the import.
        // After that we have a cached promise; we can't extract synchronously
        // without it. So we synchronously check whether the cache is primed;
        // if not, we kick off the import and return [] (the next call will
        // see the cached mapping).
        //
        // This trades correctness on the very first call for keeping
        // extractFromTree synchronous (which TreeSitterExtractor's contract
        // expects). For mapping we go async instead — see the override of
        // extractRaw below.
        throw new Error("internal: TreeSitterLanguageHandler uses async extractRaw override");
    }

    // Override extractRaw entirely so we can await both the parser and the
    // mapping import in a single coordinated path.
    override async extractRaw(content: import("../BaseHandler.ts").HandlerContent): Promise<MimeSymbol[]> {
        if (typeof content !== "string") return [];
        let parser: TreeSitterParser;
        let mapping: TreeSitterLanguageMapping;
        try {
            [parser, mapping] = await Promise.all([
                // Reach into the base's primed-promise cache via the protected
                // loadParser path. We can call loadParser directly here because
                // we're inside the subclass.
                this.#getParserCached(),
                this.#getMappingCached(),
            ]);
        } catch {
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
            parser = await this.#getParserCached();
        } catch {
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

    // Cached parser load — mirrors the base class's pattern.
    #parserCache: Promise<TreeSitterParser> | null = null;
    #getParserCached(): Promise<TreeSitterParser> {
        if (this.#parserCache === null) this.#parserCache = this.loadParser();
        return this.#parserCache;
    }

    #getMappingCached(): Promise<TreeSitterLanguageMapping> {
        if (this.#mappingPromise === null) {
            this.#mappingPromise = this.#entry.importMapping();
        }
        return this.#mappingPromise;
    }
}

// Resolve the WASM grammar file path inside the consumer's installed
// `tree-sitter-{lang}` package. Uses Node's createRequire to do
// package-relative resolution; the framework doesn't bundle the WASM, the
// consumer brings it.
async function resolveWasmPath(entry: TreeSitterLanguageEntry): Promise<string> {
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    // Resolve the package.json first (always exists at the package root)
    // and then walk to the wasm file by relative path. resolve() of the
    // bare wasm path doesn't work because most tree-sitter-* packages
    // don't list .wasm in their `exports`.
    const pkgJsonPath = require.resolve(`${entry.wasmPackage}/package.json`);
    const path = await import("node:path");
    return path.join(path.dirname(pkgJsonPath), entry.wasmFile);
}
