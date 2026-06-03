import BaseHandler from "./BaseHandler.ts";
import type { HandlerContent } from "./BaseHandler.ts";
import type { ExtractionVisitor, MimeSymbol } from "./types.ts";

// Abstract base for grammar-backed mimetype handlers. Subclasses supply two
// methods:
//   parseTree(content) — construct lexer/parser, return the entry-rule tree.
//   createVisitor()    — return an ExtractionVisitor (typically built via
//                        withExtractor(GeneratedVisitor)).
// extractRaw() orchestrates: parseTree -> createVisitor -> visit -> visitor.symbols.
// Parse and visit errors are caught and converted to an empty symbol list;
// preview() inherits BaseHandler's default (symbols-kind from extractRaw),
// which becomes an empty preview when extraction yields nothing.
export default abstract class AntlrExtractor extends BaseHandler {
    protected abstract parseTree(content: string): unknown;
    protected abstract createVisitor(): ExtractionVisitor;

    extractRaw(content: string): MimeSymbol[] {
        let tree: unknown;
        try {
            tree = this.parseTree(content);
        } catch {
            return [];
        }
        if (tree === null || tree === undefined) return [];

        const visitor = this.createVisitor();
        try {
            visitor.visit(tree);
        } catch {
            return [];
        }
        return visitor.symbols;
    }

    // Deep-channel walk per issue #10. Walks the ANTLR parse tree returned by
    // parseTree() and emits the full named-children tree with native rule and
    // token names. Each node carries `type` (derived from the antlr4ng
    // ParserRuleContext class name, stripped of the "Context" suffix and
    // lowercased — matches the grammar's rule name), `line`, `endLine`, plus
    // `text` on terminal nodes (literal source slice).
    //
    // Failures (parse error, walk exception) route to null, mirroring
    // extractRaw's empty-symbols policy. Handlers needing a custom shape
    // override this entirely.
    override deepJson(content: HandlerContent): unknown {
        if (typeof content !== "string") return null;
        let tree: unknown;
        try {
            tree = this.parseTree(content);
        } catch {
            return null;
        }
        if (tree === null || tree === undefined) return null;
        try {
            return walkAntlrTree(tree);
        } catch {
            return null;
        }
    }
}

// Duck-typed walk over an antlr4ng parse tree. The framework doesn't depend
// on antlr4ng directly — it's a peer dep — so we read fields defensively.
//
// ParserRuleContext has: { children?, start?, stop?, parser?, constructor.name }.
// TerminalNode has: { symbol: { line, type, text, ... } }.
export function walkAntlrTree(node: unknown): unknown {
    if (node === null || node === undefined) return null;
    const n = node as Record<string, unknown>;

    // Terminal node — wraps a single token under `symbol`.
    if (typeof n.symbol === "object" && n.symbol !== null && !("children" in n)) {
        const sym = n.symbol as { line?: number; text?: string; type?: number };
        return {
            type: tokenTypeName(node, sym),
            line: sym.line ?? 1,
            endLine: sym.line ?? 1,
            text: sym.text ?? "",
        };
    }

    // Rule context — has start/stop tokens for positions and children for
    // recursive descent.
    const start = n.start as { line?: number } | undefined;
    const stop = n.stop as { line?: number } | undefined;
    const out: Record<string, unknown> = {
        type: ruleNameOf(node),
        line: start?.line ?? 1,
        endLine: stop?.line ?? start?.line ?? 1,
    };

    const children = n.children as unknown[] | undefined;
    if (Array.isArray(children) && children.length > 0) {
        const walked: unknown[] = [];
        for (const child of children) {
            const w = walkAntlrTree(child);
            if (w !== null) walked.push(w);
        }
        if (walked.length > 0) out.children = walked;
    }
    return out;
}

// Derive a stable type name for a rule-context node from its class name.
// antlr4ng convention: `Compilation_unitContext` → `compilation_unit`.
// PascalCase grammars (less common) become camelCase: `ClassDeclarationContext`
// → `classDeclaration`. Fallback: `node`.
function ruleNameOf(ctx: unknown): string {
    const className = (ctx as { constructor?: { name?: string } }).constructor?.name ?? "";
    if (className.length === 0) return "node";
    const base = className.endsWith("Context") ? className.slice(0, -7) : className;
    if (base.length === 0) return "node";
    return base.charAt(0).toLowerCase() + base.slice(1);
}

// Try to resolve a token's symbolic name via its parser's vocabulary. Falls
// back to the literal token text (for punctuation/keywords) or "token" for
// unrecognized cases. Some grammars don't expose vocabulary in a stable way;
// duck-typed access keeps the walker robust.
function tokenTypeName(terminal: unknown, sym: { type?: number; text?: string }): string {
    const parent = (terminal as { parent?: unknown }).parent;
    const vocab = (parent as { parser?: { vocabulary?: { getSymbolicName?: (t: number) => string | null } } })
        ?.parser?.vocabulary;
    if (vocab?.getSymbolicName && typeof sym.type === "number") {
        const name = vocab.getSymbolicName(sym.type);
        if (typeof name === "string" && name.length > 0) return name;
    }
    if (typeof sym.text === "string" && sym.text.length > 0 && sym.text.length <= 10) {
        // Short token text (likely a keyword or punctuation) — use as the type
        // so xpath/jsonpath can match on it directly: $..[?(@.type=='class')].
        return sym.text;
    }
    return "token";
}
