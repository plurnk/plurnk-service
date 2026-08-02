import TreeSitterExtractor, { walkDeepNode } from "../TreeSitterExtractor.ts";
import type { QueryConstructor, TreeSitterParser, TreeSitterTree } from "../TreeSitterExtractor.ts";
import type { HandlerMetadata, MimeRef, MimeSymbol } from "../types.ts";
import type { TreeSitterLanguageEntry, TreeSitterLanguageMapping } from "./registry.ts";

// Internal registry-entry adapter; parser and mapping are lazy-loaded together.
export default class TreeSitterLanguageHandler extends TreeSitterExtractor {
    readonly #entry: TreeSitterLanguageEntry;
    #mappingPromise: Promise<TreeSitterLanguageMapping> | null = null;

    constructor(metadata: HandlerMetadata, entry: TreeSitterLanguageEntry) {
        super(metadata);
        this.#entry = entry;
    }

    protected override async loadParser(): Promise<TreeSitterParser> {
        // Parsing requests alone pay runtime initialization.
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
        // Prime the shared references engine with the loaded language.
        this.setQueryContext(lang, ts.Query);
        const parser = new ts.Parser();
        parser.setLanguage(lang);
        return parser as unknown as TreeSitterParser;
    }

    // Mapping-owned query through the shared engine ({§mimetype-references}).
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

    // Parser and mapping imports form one coordinated extraction boundary.
    override async extractRaw(content: import("../BaseHandler.ts").HandlerContent): Promise<MimeSymbol[]> {
        if (typeof content !== "string") return [];
        let parser: TreeSitterParser;
        let mapping: TreeSitterLanguageMapping;
        try {
            [parser, mapping] = await Promise.all([
                this.getParser(),
                this.#getMappingCached(),
            ]);
        } catch (err) {
            // Missing grammar selects explicit structural degradation; #92
            // owns separating every other import/parse defect.
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

    // Reuse the parser cache; an algebra-specific mapping projection wins over
    // the generic named-node walk ({§mimetype-channel-architecture}).
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
            return walkDeepNode(tree.rootNode, content);
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

// Resolve only the reproducible leaf artifact ({§mimetype-grammar-leaves}).
async function resolveWasmPath(entry: TreeSitterLanguageEntry): Promise<string> {
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const path = await import("node:path");

    const plurnkPackage = `@plurnk/plurnk-mimetypes-grammar-${entry.slug}`;
    try {
        const pkgJsonPath = require.resolve(`${plurnkPackage}/package.json`);
        return path.join(path.dirname(pkgJsonPath), `${entry.slug}.wasm`);
    } catch {
        throw new GrammarNotInstalledError(entry, plurnkPackage);
    }
}

// Thrown when the grammar leaf is absent. Caller
// (TreeSitterExtractor.extractRaw) catches this and routes to the
// empty-symbols error policy; plurnk-service can surface the install hint.
export class GrammarNotInstalledError extends Error {
    readonly mimetype: string;
    readonly slug: string;
    readonly plurnkPackage: string;

    constructor(entry: TreeSitterLanguageEntry, plurnkPackage: string) {
        super(`No grammar installed for ${entry.mimetype}. Install ${plurnkPackage} to enable this language.`);
        this.name = "GrammarNotInstalledError";
        this.mimetype = entry.mimetype;
        this.slug = entry.slug;
        this.plurnkPackage = plurnkPackage;
    }
}
