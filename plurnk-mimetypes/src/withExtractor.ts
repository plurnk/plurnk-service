import type { ParserRuleContext } from "antlr4ng";
import type { ExtractionVisitor, MimeRef, MimeSymbol, RefKind, SymbolKind } from "./types.ts";

// Generic constructor shape for any antlr4ng generated visitor. The `any[]`
// rest is required by TypeScript's mixin pattern (TS2545).
type VisitorCtor = new (...args: any[]) => {
    visit(tree: unknown): unknown;
    visitChildren(node: unknown): unknown;
};

// Public surface added by the mixin. addSymbol/gateBody/inBody are intended for
// subclass use from visit* methods — not for external callers. They are public
// on the type so declaration files emit cleanly (TS4094).
interface ExtractorMethods extends ExtractionVisitor {
    readonly inBody: boolean;
    readonly refs: MimeRef[];
    addSymbol(
        kind: SymbolKind,
        name: string,
        ctx: ParserRuleContext,
        params?: string[],
        extra?: Partial<MimeSymbol>,
    ): void;
    // Emit a classified symbol use (ANTLR references grind). Positions come
    // from `ctx` like addSymbol; `container` is the active gateContainer path
    // (the @> join key — the enclosing emitted definition). Never emit a
    // definition's own name node, a string-literal, or a comment as a ref —
    // the conformance invariants reject those.
    addRef(
        kind: RefKind,
        name: string,
        ctx: ParserRuleContext,
        extra?: Partial<MimeRef>,
    ): void;
    gateBody(ctx: ParserRuleContext): null;
    gateContainer(name: string, ctx: ParserRuleContext): null;
}

type MixedCtor<T extends VisitorCtor> = new (
    ...args: ConstructorParameters<T>
) => InstanceType<T> & ExtractorMethods;

// Mixin that adds symbol-collection state and helpers to any antlr4ng visitor.
// Subclasses extend `withExtractor(GeneratedVisitor)` and override visit* methods
// for declaration rules, calling `addSymbol(...)` when they find one. Wrap the
// recursion into a function body with `gateBody(ctx)` so nested declarations can
// be filtered via `this.inBody`.
export function withExtractor<T extends VisitorCtor>(Base: T): MixedCtor<T> {
    const Mixed = class extends Base implements ExtractorMethods {
        readonly #symbols: MimeSymbol[] = [];
        readonly #refs: MimeRef[] = [];
        readonly #containers: string[] = [];
        #inBody = false;

        get symbols(): MimeSymbol[] {
            return [...this.#symbols];
        }

        get refs(): MimeRef[] {
            // Document order (SPEC §16 conformance invariant), matching the
            // tree-sitter refsEngine. Visitors emit in traversal order, which
            // is usually document order but not always — e.g. a helper that
            // collects sibling nodes via a stack walk returns them reversed.
            // Sorting here makes every ANTLR handler's refs ordered for free.
            return [...this.#refs].sort((a, b) => a.line - b.line || a.column - b.column);
        }

        get inBody(): boolean {
            return this.#inBody;
        }

        addRef(
            kind: RefKind,
            name: string,
            ctx: ParserRuleContext,
            extra?: Partial<MimeRef>,
        ): void {
            const startLine = ctx.start?.line ?? 0;
            const ref: MimeRef = {
                name,
                kind,
                line: startLine,
                column: (ctx.start?.column ?? 0) + 1,
                endLine: ctx.stop?.line ?? startLine,
                endColumn: (ctx.stop?.column ?? 0) + (ctx.stop?.text?.length ?? 0) + 1,
            };
            if (this.#containers.length > 0) ref.container = this.#containers.join(".");
            if (extra !== undefined) Object.assign(ref, extra);
            this.#refs.push(ref);
        }

        addSymbol(
            kind: SymbolKind,
            name: string,
            ctx: ParserRuleContext,
            params?: string[],
            extra?: Partial<MimeSymbol>,
        ): void {
            const startLine = ctx.start?.line ?? 0;
            const stopLine = ctx.stop?.line ?? startLine;
            const symbol: MimeSymbol = {
                name,
                kind,
                line: startLine,
                endLine: stopLine,
            };
            // antlr4ng columns are 0-indexed char positions; MimeSymbol columns
            // are 1-indexed (issue #18). stop.column is the start of the last
            // token — add its text length for the end position. Guarded per
            // field: columns are optional on MimeSymbol and some grammar
            // contexts lack position info.
            if (typeof ctx.start?.column === "number") symbol.column = ctx.start.column + 1;
            if (typeof ctx.stop?.column === "number") {
                symbol.endColumn = ctx.stop.column + (ctx.stop.text?.length ?? 0) + 1;
            }
            if (this.#containers.length > 0) symbol.container = this.#containers.join(".");
            if (params !== undefined) symbol.params = params;
            if (extra !== undefined) Object.assign(symbol, extra);
            this.#symbols.push(symbol);
        }

        gateBody(ctx: ParserRuleContext): null {
            const was = this.#inBody;
            this.#inBody = true;
            this.visitChildren(ctx);
            this.#inBody = was;
            return null;
        }

        // Visit children inside a named container scope (issue #18): symbols
        // added during the recursion carry `container` = the dotted path of
        // enclosing gateContainer names. Call after addSymbol-ing the
        // container's own symbol so it doesn't contain itself.
        gateContainer(name: string, ctx: ParserRuleContext): null {
            this.#containers.push(name);
            try {
                this.visitChildren(ctx);
            } finally {
                this.#containers.pop();
            }
            return null;
        }
    };
    return Mixed as unknown as MixedCtor<T>;
}
