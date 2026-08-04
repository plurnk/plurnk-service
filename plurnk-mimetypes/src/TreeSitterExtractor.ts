import BaseHandler from "./BaseHandler.ts";
import type { HandlerContent } from "./BaseHandler.ts";
import ParserCoordinates, { isParserCoordinateError } from "./ParserCoordinates.ts";
import type { MimeRef, MimeSymbol } from "./types.ts";
import { collectReferences } from "./treesitter/refsEngine.ts";
import type { RefsQuery } from "./treesitter/refsEngine.ts";

// web-tree-sitter's Query constructor, typed locally. Produces a raw query
// object; for most languages it already satisfies RefsQuery (it exposes
// captures()), so collectRefs() uses it directly. A language needing
// match-level composition (HCL) passes a `wrap` that adapts the raw object.
export type QueryConstructor = new (language: unknown, source: string) => unknown;

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
    // Present on web-tree-sitter nodes. Optional here preserves the public
    // structural seam for adapters that supply point-only synthetic nodes.
    readonly startIndex?: number;
    readonly endIndex?: number;
    readonly startPosition: { row: number; column: number };
    readonly endPosition: { row: number; column: number };
    readonly childCount: number;
    readonly namedChildCount: number;
    readonly nextNamedSibling: TreeSitterNode | null;
    child(index: number): TreeSitterNode | null;
    namedChild(index: number): TreeSitterNode | null;
    childForFieldName(name: string): TreeSitterNode | null;
    descendantsOfType(types: string | string[]): TreeSitterNode[];
}

// Shared tree-sitter adapter ({§mimetype-backend-selection}). Subclasses supply
// parser loading and symbol projection; current failure collapsing is #92.
export default abstract class TreeSitterExtractor extends BaseHandler {
    #parserPromise: Promise<unknown> | null = null;
    // loadParser() primes the language/query pair used by the shared engine.
    #language: unknown = null;
    #QueryCtor: QueryConstructor | null = null;
    #refsQuery: RefsQuery | null = null;
    #rawRefsQuery: { delete?(): void } | null = null;
    #disposePromise: Promise<void> | null = null;

    protected abstract loadParser(): Promise<TreeSitterParser>;
    protected abstract extractFromTree(tree: TreeSitterTree, content: string): MimeSymbol[];

    // Required before collectRefs() so query compilation shares parser state.
    protected setQueryContext(language: unknown, QueryCtor: QueryConstructor): void {
        this.#language = language;
        this.#QueryCtor = QueryCtor;
    }

    // One parser/query/cache path for dedicated references handlers
    // ({§mimetype-references}). `wrap` adapts match-level composition.
    protected async collectRefs(
        content: HandlerContent,
        querySource: string,
        extractDefs: (root: TreeSitterNode, content: string) => MimeSymbol[],
        wrap?: (rawQuery: unknown) => RefsQuery,
    ): Promise<MimeRef[]> {
        if (typeof content !== "string") return [];
        let parser: TreeSitterParser;
        try {
            parser = await this.getParser();
        } catch (err) {
            if (isGrammarNotInstalled(err)) throw err;
            return [];
        }
        const query = this.#primeRefsQuery(querySource, wrap);
        let tree: TreeSitterTree | null;
        try {
            tree = parser.parse(content);
            if (!tree) return [];
        } catch {
            return [];
        }
        try {
            return collectReferences(query, tree, extractDefs(tree.rootNode, content));
        } catch (error) {
            if (isParserCoordinateError(error)) throw error;
            return [];
        } finally {
            tree?.delete?.();
        }
    }

    // Query source is constant per handler instance.
    #primeRefsQuery(source: string, wrap?: (rawQuery: unknown) => RefsQuery): RefsQuery {
        if (this.#refsQuery === null) {
            if (this.#language === null || this.#QueryCtor === null) {
                throw new Error("internal: collectRefs() before loadParser() called setQueryContext()");
            }
            const raw = new this.#QueryCtor(this.#language, source);
            this.#rawRefsQuery = raw as { delete?(): void };
            this.#refsQuery = wrap ? wrap(raw) : (raw as RefsQuery);
        }
        return this.#refsQuery;
    }

    override async extractRaw(content: HandlerContent): Promise<MimeSymbol[]> {
        if (typeof content !== "string") return [];
        let parser: TreeSitterParser;
        try {
            parser = await this.getParser();
        } catch (err) {
            // Missing grammar selects the explicit structural degradation;
            // #92 owns separating every other load/parse defect.
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
        } catch (error) {
            if (isParserCoordinateError(error)) throw error;
            return [];
        } finally {
            tree?.delete?.();
        }
    }

    // Native named-node structural walk ({§mimetype-channel-architecture}).
    override async deepJson(content: HandlerContent): Promise<unknown> {
        if (typeof content !== "string") return null;
        let parser: TreeSitterParser;
        try {
            parser = await this.getParser();
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
            return walkDeepNode(tree.rootNode, content);
        } catch (error) {
            if (isParserCoordinateError(error)) throw error;
            return null;
        } finally {
            tree?.delete?.();
        }
    }

    // One parser/WASM instance per handler lifetime.
    protected getParser(): Promise<TreeSitterParser> {
        this.#parserPromise ??= this.loadParser();
        return this.#parserPromise as Promise<TreeSitterParser>;
    }

    // web-tree-sitter retains explicit parser/query resources
    // ({§mimetype-lifecycle}). Query teardown precedes its parser owner.
    override async dispose(): Promise<void> {
        if (this.#disposePromise !== null) return this.#disposePromise;
        const disposal = this.#disposeResources();
        this.#disposePromise = disposal;
        try {
            await disposal;
        } finally {
            if (this.#disposePromise === disposal) this.#disposePromise = null;
        }
    }

    async #disposeResources(): Promise<void> {
        const query = this.#rawRefsQuery;
        const parser = this.#parserPromise;
        this.#rawRefsQuery = null;
        this.#refsQuery = null;
        this.#parserPromise = null;
        this.#language = null;
        this.#QueryCtor = null;

        const queryResults = await Promise.allSettled([
            Promise.resolve().then(() => query?.delete?.()),
        ]);
        const parserResults = await Promise.allSettled([
            parser === null
                ? Promise.resolve()
                : parser.then((resolved) => (resolved as TreeSitterParser).delete?.()),
        ]);
        const errors = [...queryResults, ...parserResults]
            .filter((result): result is PromiseRejectedResult => result.status === "rejected")
            .map((result) => result.reason);
        if (errors.length > 0) throw new AggregateError(errors, "Tree-sitter handler shutdown failed");
    }
}

// Parser surface we depend on. web-tree-sitter's Parser exposes `parse`
// which accepts a string (or callback) and returns Tree | null.
export interface TreeSitterParser {
    parse(content: string): TreeSitterTree | null;
    delete?(): void;
}

// Duck-typed check for GrammarNotInstalledError without a circular import.
// The error itself is defined in src/treesitter/handler.ts which depends on
// this file; we just look for the marker. Duck-typing (not instanceof) is
// also what keeps the check correct when the error originates from a handler
// package's bundled copy of the framework — instanceof fails across realms.
export function isGrammarNotInstalled(err: unknown): boolean {
    return typeof err === "object"
        && err !== null
        && (err as { name?: string }).name === "GrammarNotInstalledError";
}

// Shape of a node in the deep-json tree returned by deepJson(). One per
// tree-sitter node walked via namedChild traversal.
export interface DeepTreeNode {
    type: string;
    line: number;
    column?: number;
    endLine: number;
    endColumn?: number;
    text?: string;
    children?: DeepTreeNode[];
}

// Public so handlers can call it from a custom deepJson override (e.g. to walk
// a fragment of the tree, or to combine the AST with additional metadata).
export function walkDeepNode(node: TreeSitterNode, content?: string): DeepTreeNode {
    return walkIndexedDeepNode(
        node,
        content === undefined ? undefined : new ParserCoordinates(content),
    );
}

function walkIndexedDeepNode(
    node: TreeSitterNode,
    coordinates: ParserCoordinates | undefined,
): DeepTreeNode {
    const region = coordinates === undefined
        ? null
        : coordinates.treeSitterNode(node);
    const out: DeepTreeNode = {
        type: node.type,
        line: region?.startLine ?? node.startPosition.row + 1,
        endLine: region?.endLine ?? node.endPosition.row + 1,
        ...(region === null ? {} : {
            column: region.startColumn,
            endColumn: region.endColumn,
        }),
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
        if (child) children.push(walkIndexedDeepNode(child, coordinates));
    }
    if (children.length > 0) out.children = children;
    return out;
}
