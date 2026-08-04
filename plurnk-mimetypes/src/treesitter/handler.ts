import TreeSitterExtractor, { walkDeepNode } from "../TreeSitterExtractor.ts";
import type { QueryConstructor, TreeSitterParser, TreeSitterTree } from "../TreeSitterExtractor.ts";
import { materializeTreeSitterSymbols } from "../ParserCoordinates.ts";
import { isExactModuleAbsent } from "../module-absence.ts";
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
        return this.collectRefs(
            content,
            mapping.refsQuery,
            (root, source) => materializeTreeSitterSymbols(source, mapping.extract(root, source)),
        );
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
        const [parser, mapping] = await Promise.all([
            this.getParser(),
            this.#getMappingCached(),
        ]);
        const tree = parser.parse(content) as TreeSitterTree | null;
        if (!tree) return [];
        try {
            const projections = mapping.extract(tree.rootNode, content);
            return materializeTreeSitterSymbols(content, projections);
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
            return mapping.deepJson(content);
        }
        const parser = await this.getParser();
        const tree = parser.parse(content) as TreeSitterTree | null;
        if (!tree) return null;
        try {
            return walkDeepNode(tree.rootNode, content);
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
export async function resolveWasmPath(entry: TreeSitterLanguageEntry): Promise<string> {
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const path = await import("node:path");

    const plurnkPackage = `@plurnk/plurnk-mimetypes-grammar-${entry.slug}`;
    const manifestSpecifier = `${plurnkPackage}/package.json`;
    try {
        const pkgJsonPath = require.resolve(manifestSpecifier);
        return path.join(path.dirname(pkgJsonPath), `${entry.slug}.wasm`);
    } catch (cause) {
        if (isExactModuleAbsent(cause, manifestSpecifier)) {
            throw new GrammarNotInstalledError(entry, plurnkPackage);
        }
        throw cause;
    }
}

// Thrown when the grammar leaf is absent. Mimetypes.process() owns the
// non-strict empty-channel degradation and install Notice.
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
