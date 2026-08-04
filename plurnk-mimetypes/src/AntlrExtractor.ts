import BaseHandler from "./BaseHandler.ts";
import type { HandlerContent } from "./BaseHandler.ts";
import ParserCoordinates from "./ParserCoordinates.ts";
import type { ExtractionVisitor, MimeRef, MimeSymbol } from "./types.ts";

// ANTLR handler adapter ({§mimetype-backend-selection}). Subclasses supply the
// entry parse and visitor. A null tree is honest absence; thrown parser or
// visitor failures retain their causal identity.
export default abstract class AntlrExtractor extends BaseHandler {
    protected abstract parseTree(content: string): unknown;
    protected abstract createVisitor(): ExtractionVisitor;

    extractRaw(content: string): MimeSymbol[] {
        const tree = this.parseTree(content);
        if (tree === null || tree === undefined) return [];

        const visitor = this.createVisitor();
        visitor.bindContent?.(content);
        visitor.visit(tree);
        return visitor.symbols;
    }

    // Classified uses from the same visitor contract ({§mimetype-references}).
    override references(content: HandlerContent): MimeRef[] {
        if (typeof content !== "string") return [];
        const tree = this.parseTree(content);
        if (tree === null || tree === undefined) return [];

        const visitor = this.createVisitor();
        visitor.bindContent?.(content);
        visitor.visit(tree);
        return visitor.refs ?? [];
    }

    // Native-rule structural walk ({§mimetype-channel-architecture}).
    override deepJson(content: HandlerContent): unknown {
        if (typeof content !== "string") return null;
        const tree = this.parseTree(content);
        if (tree === null || tree === undefined) return null;
        return walkAntlrTree(tree, content);
    }
}

// Duck-typed walk over an antlr4ng parse tree. Generated grammar packages can
// expose distinct concrete context classes, so the shared walker reads only
// the stable runtime fields it owns.
//
// ParserRuleContext has: { children?, start?, stop?, parser?, constructor.name }.
// TerminalNode has: { symbol: { line, type, text, ... } }.
export function walkAntlrTree(node: unknown, content?: string): unknown {
    return walkAntlrNode(
        node,
        content === undefined ? undefined : new ParserCoordinates(content),
    );
}

function walkAntlrNode(node: unknown, coordinates: ParserCoordinates | undefined): unknown {
    if (node === null || node === undefined) return null;
    const n = node as Record<string, unknown>;

    // Terminal node — wraps a single token under `symbol`.
    if (typeof n.symbol === "object" && n.symbol !== null && !("children" in n)) {
        const sym = n.symbol as { line?: number; text?: string; type?: number };
        const region = coordinates?.antlrToken(sym);
        return {
            type: tokenTypeName(node, sym),
            line: region?.startLine ?? sym.line ?? 1,
            endLine: region?.endLine ?? sym.line ?? 1,
            ...(region === undefined ? {} : {
                column: region.startColumn,
                endColumn: region.endColumn,
            }),
            text: sym.text ?? "",
        };
    }

    // Rule context — has start/stop tokens for positions and children for
    // recursive descent.
    const start = n.start as { line?: number } | undefined;
    const stop = n.stop as { line?: number } | undefined;
    // Source-bound walks use absolute offsets. This line-only fallback keeps
    // the public source-less helper ordered for synthetic callers.
    const startLine = start?.line ?? 1;
    const stopLine = stop?.line;
    const region = coordinates?.antlrContext(n);
    const out: Record<string, unknown> = {
        type: ruleNameOf(node),
        line: region?.startLine ?? startLine,
        endLine: region?.endLine
            ?? (typeof stopLine === "number" && stopLine >= startLine ? stopLine : startLine),
        ...(region === undefined ? {} : {
            column: region.startColumn,
            endColumn: region.endColumn,
        }),
    };

    const children = n.children as unknown[] | undefined;
    if (Array.isArray(children) && children.length > 0) {
        const walked: unknown[] = [];
        for (const child of children) {
            const w = walkAntlrNode(child, coordinates);
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
