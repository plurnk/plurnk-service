import type { ParserRuleContext } from "antlr4ng";
import type { ExtractionVisitor, MimeSymbol, SymbolKind } from "./types.ts";

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
    addSymbol(
        kind: SymbolKind,
        name: string,
        ctx: ParserRuleContext,
        params?: string[],
        extra?: Partial<MimeSymbol>,
    ): void;
    gateBody(ctx: ParserRuleContext): null;
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
        #inBody = false;

        get symbols(): MimeSymbol[] {
            return [...this.#symbols];
        }

        get inBody(): boolean {
            return this.#inBody;
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
    };
    return Mixed as unknown as MixedCtor<T>;
}
