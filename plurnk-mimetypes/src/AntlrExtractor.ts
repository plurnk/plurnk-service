import BaseHandler from "./BaseHandler.ts";
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
}
