import BaseHandler from "./BaseHandler.ts";
import type { HandlerContent } from "./BaseHandler.ts";
import type { MimeSymbol } from "./types.ts";

// Tree-sitter parser-tree types. We only use a small surface (parse, root
// node, traversal) so we type-import via `unknown`-wrapped abstractions
// rather than depending on the runtime types from web-tree-sitter. This
// lets the framework type-check without web-tree-sitter installed; the
// handler subclass imports the runtime as its own dep.
export interface TreeSitterTree {
    readonly rootNode: TreeSitterNode;
    delete?(): void;
}

export interface TreeSitterNode {
    readonly type: string;
    readonly text: string;
    readonly startPosition: { row: number; column: number };
    readonly endPosition: { row: number; column: number };
    readonly childCount: number;
    readonly namedChildCount: number;
    child(index: number): TreeSitterNode | null;
    namedChild(index: number): TreeSitterNode | null;
    childForFieldName(name: string): TreeSitterNode | null;
    descendantsOfType(types: string | string[]): TreeSitterNode[];
}

// Abstract base for tree-sitter-backed handlers. Subclasses supply two
// methods:
//   - loadParser() — async; returns a ready Parser bound to a Language.
//                    Typically:
//                       const { Parser, Language } = await import("web-tree-sitter");
//                       await Parser.init();
//                       const parser = new Parser();
//                       parser.setLanguage(await Language.load(grammarWasmPath));
//                       return parser;
//   - extractFromTree(tree, content) — sync; walk the parsed tree, return
//                    MimeSymbol[]. The base class hands you the tree and
//                    the original content for source-range slicing.
//
// extractRaw() orchestrates: lazy-load parser (cached), parse, dispatch to
// extractFromTree. Parse and visit errors are caught and converted to an
// empty symbol list, mirroring AntlrExtractor.
export default abstract class TreeSitterExtractor extends BaseHandler {
    #parserPromise: Promise<unknown> | null = null;

    protected abstract loadParser(): Promise<TreeSitterParser>;
    protected abstract extractFromTree(tree: TreeSitterTree, content: string): MimeSymbol[];

    override async extractRaw(content: HandlerContent): Promise<MimeSymbol[]> {
        if (typeof content !== "string") return [];
        let parser: TreeSitterParser;
        try {
            parser = await this.#getParser();
        } catch {
            return [];
        }
        let tree: TreeSitterTree | null;
        try {
            tree = parser.parse(content);
            if (!tree) return [];
        } catch {
            return [];
        }
        try {
            return this.extractFromTree(tree, content);
        } catch {
            return [];
        } finally {
            tree?.delete?.();
        }
    }

    // Primed-promise cache: subsequent calls reuse the parser. The parser
    // owns the WASM grammar; we keep it alive for the handler's lifetime.
    async #getParser(): Promise<TreeSitterParser> {
        if (this.#parserPromise === null) {
            this.#parserPromise = this.loadParser();
        }
        return this.#parserPromise as Promise<TreeSitterParser>;
    }
}

// Parser surface we depend on. web-tree-sitter's Parser exposes `parse`
// which accepts a string (or callback) and returns Tree | null.
export interface TreeSitterParser {
    parse(content: string): TreeSitterTree | null;
}
