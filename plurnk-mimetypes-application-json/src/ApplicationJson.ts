import { BaseHandler } from "@plurnk/plurnk-mimetypes";
import type { MimeSymbol } from "@plurnk/plurnk-mimetypes";
import { type Node, type ParseError, parseTree, printParseErrorCode } from "jsonc-parser";

// One class serves two mimetype names — application/json (strict) and
// application/jsonc (comments + trailing commas allowed). The framework
// constructs one instance per registered name; this.mimetype distinguishes
// them at runtime.
//
// validate(): strict for application/json (no comments, no trailing commas);
//             permissive for application/jsonc. Errors propagate per SPEC §7.
//
// extract(): every key occurrence at every depth as a `field` symbol, with
//            line numbers from jsonc-parser's positional tree (Node.offset).
//            No regex tokenization, no escape-handling reinvention — the
//            parser does it.
export default class ApplicationJson extends BaseHandler {
    validate(content: string): void {
        const errors: ParseError[] = [];
        const allowsRelaxation = this.mimetype === "application/jsonc";
        parseTree(content, errors, {
            allowTrailingComma: allowsRelaxation,
            disallowComments: !allowsRelaxation,
        });
        if (errors.length === 0) return;
        const first = errors[0];
        const { line, column } = offsetToLineCol(content, first.offset);
        throw new SyntaxError(
            `${printParseErrorCode(first.error)} at line ${line}:${column}`,
        );
    }

    extract(content: string): MimeSymbol[] {
        const errors: ParseError[] = [];
        const allowsRelaxation = this.mimetype === "application/jsonc";
        const tree = parseTree(content, errors, {
            allowTrailingComma: allowsRelaxation,
            disallowComments: !allowsRelaxation,
        });
        if (tree === undefined) return [];

        const symbols: MimeSymbol[] = [];
        collectKeys(tree, content, symbols);
        return symbols;
    }
}

// Walk a jsonc-parser Node tree and emit a field symbol for every property
// key encountered at every depth. Each property node has a `children` pair:
// [keyNode, valueNode]. The keyNode's offset gives the source position.
function collectKeys(node: Node, content: string, into: MimeSymbol[]): void {
    if (node.type === "property" && node.children && node.children.length >= 2) {
        const keyNode = node.children[0];
        if (keyNode.type === "string" && typeof keyNode.value === "string") {
            const line = offsetToLineCol(content, keyNode.offset).line;
            into.push({
                name: keyNode.value,
                kind: "field",
                line,
                endLine: line,
            });
        }
        // Recurse into the value to find nested keys.
        const valueNode = node.children[1];
        if (valueNode) collectKeys(valueNode, content, into);
        return;
    }

    // Objects, arrays, and the root all recurse through children.
    if (node.children) {
        for (const child of node.children) {
            collectKeys(child, content, into);
        }
    }
}

// Convert a byte offset into 1-indexed line/column.
function offsetToLineCol(content: string, offset: number): { line: number; column: number } {
    let line = 1;
    let column = 1;
    const limit = Math.min(offset, content.length);
    for (let i = 0; i < limit; i += 1) {
        if (content.charCodeAt(i) === 0x0a) {
            line += 1;
            column = 1;
        } else {
            column += 1;
        }
    }
    return { line, column };
}
