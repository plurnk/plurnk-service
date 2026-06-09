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
        } catch (err) {
            // GrammarNotInstalledError is signal-bearing — propagates so
            // Mimetypes.process() can degrade to text-plain with a
            // grammarMissing hint per issue #14. Other parser-load errors
            // (corrupt WASM, web-tree-sitter init failure) are silently
            // routed to empty symbols per the long-standing handler error
            // policy.
            if (isGrammarNotInstalled(err)) throw err;
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

    // Deep-channel walk per issue #10. Returns the full named-children tree of
    // the parsed AST with native tree-sitter node types. Each node carries
    // `type`, `line`, `endLine`. Leaves (no named children) additionally carry
    // `text` — the source slice for that node. Internal nodes have `children`.
    // Failures route to null (empty deep-json) matching extractRaw's policy.
    override async deepJson(content: HandlerContent): Promise<unknown> {
        if (typeof content !== "string") return null;
        let parser: TreeSitterParser;
        try {
            parser = await this.#getParser();
        } catch (err) {
            if (isGrammarNotInstalled(err)) throw err;
            return null;
        }
        let tree: TreeSitterTree | null;
        try {
            tree = parser.parse(content);
            if (!tree) return null;
        } catch {
            return null;
        }
        try {
            return walkDeepNode(tree.rootNode);
        } catch {
            return null;
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

// Duck-typed check for GrammarNotInstalledError without a circular import.
// The error itself is defined in src/treesitter/handler.ts which depends on
// this file; we just look for the marker.
function isGrammarNotInstalled(err: unknown): boolean {
    return typeof err === "object"
        && err !== null
        && (err as { name?: string }).name === "GrammarNotInstalledError";
}

// Shape of a node in the deep-json tree returned by deepJson(). One per
// tree-sitter node walked via namedChild traversal.
export interface DeepTreeNode {
    type: string;
    line: number;
    endLine: number;
    text?: string;
    children?: DeepTreeNode[];
}

// Public so handlers can call it from a custom deepJson override (e.g. to walk
// a fragment of the tree, or to combine the AST with additional metadata).
export function walkDeepNode(node: TreeSitterNode): DeepTreeNode {
    const out: DeepTreeNode = {
        type: node.type,
        line: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
    };
    if (node.namedChildCount === 0) {
        // Leaf — preserve source text so jsonpath can match against identifier
        // / literal content. Skip empty strings to avoid noise.
        if (node.text.length > 0) out.text = node.text;
        return out;
    }
    const children: DeepTreeNode[] = [];
    for (let i = 0; i < node.namedChildCount; i += 1) {
        const child = node.namedChild(i);
        if (child) children.push(walkDeepNode(child));
    }
    if (children.length > 0) out.children = children;
    return out;
}
