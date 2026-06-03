import {
    BaseHandler,
    queryJsonpathObject,
    QueryParseFailureError,
} from "@plurnk/plurnk-mimetypes";
import type {
    HandlerContent,
    MimeSymbol,
    QueryDialect,
    QueryMatch,
} from "@plurnk/plurnk-mimetypes";
import {
    findNodeAtLocation,
    getNodeValue,
    type Node,
    parse as parseJsonc,
    type ParseError,
    parseTree,
    printParseErrorCode,
} from "jsonc-parser";

// One class serves two mimetype names — application/json (strict) and
// application/jsonc (comments + trailing commas allowed). The framework
// constructs one instance per registered name; this.mimetype distinguishes
// them at runtime.
//
// validate(): strict for application/json (no comments, no trailing commas);
//             permissive for application/jsonc. Errors propagate per SPEC §7.
//
// extractRaw(): every key occurrence at every depth as a `field` symbol, with
//               line numbers from jsonc-parser's positional tree (Node.offset).
//               No regex tokenization, no escape-handling reinvention — the
//               parser does it.
export default class ApplicationJson extends BaseHandler {
    override validate(content: string): void {
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

    override extractRaw(content: string): MimeSymbol[] {
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

    // Deep-channel (issue #10). For JSON, the deep-json IS the parsed value
    // tree — users writing jsonpath like `$.server.host` expect the actual
    // parsed value back, not a transformation. The framework's
    // projectJsonToXml renders this directly into deep-xml.
    //
    // jsonc relaxations are applied per mimetype. Malformed content returns
    // null (parse failure is non-fatal here; validate() is the strict gate).
    override deepJson(content: HandlerContent): unknown {
        if (typeof content !== "string") return null;
        const allowsRelaxation = this.mimetype === "application/jsonc";
        // jsonc-parser's `parse` returns plain-prototype objects (unlike
        // parseTree+getNodeValue which returns null-prototype objects that
        // confuse downstream consumers' structural comparisons).
        const errors: ParseError[] = [];
        const value = parseJsonc(content, errors, {
            allowTrailingComma: allowsRelaxation,
            disallowComments: !allowsRelaxation,
        });
        if (errors.length > 0) return null;
        return value ?? null;
    }

    // Override jsonpath dispatch so queries hit the parsed JSON value (the
    // actual data the model is asking about) rather than the bare-leaves
    // outline of keys. Line numbers for matches come from jsonc-parser's
    // positional tree: findNodeAtLocation walks segments to the result node,
    // and the node's offset maps to a source line.
    //
    // regex/glob inherit BaseHandler's defaults (against the raw JSON text).
    // xpath inherits the unsupported-dialect throw.
    override async query(
        content: HandlerContent,
        dialect: QueryDialect,
        pattern: string,
        flags?: string,
    ): Promise<QueryMatch[]> {
        if (dialect === "jsonpath") {
            if (typeof content !== "string") {
                throw new QueryParseFailureError({
                    mimetype: this.mimetype,
                    cause: new TypeError("application/json content must be a string"),
                });
            }
            const errors: ParseError[] = [];
            const allowsRelaxation = this.mimetype === "application/jsonc";
            const tree = parseTree(content, errors, {
                allowTrailingComma: allowsRelaxation,
                disallowComments: !allowsRelaxation,
            });
            if (tree === undefined || errors.length > 0) {
                throw new QueryParseFailureError({
                    mimetype: this.mimetype,
                    cause: errors[0]
                        ? new SyntaxError(printParseErrorCode(errors[0].error))
                        : new SyntaxError("empty JSON"),
                });
            }
            const value = getNodeValue(tree) as unknown;
            const lineFor = (path: string): number => {
                const segments = pathToSegments(path);
                const node = findNodeAtLocation(tree, segments);
                if (node === undefined) return 1;
                return offsetToLineCol(content, node.offset).line;
            };
            return queryJsonpathObject(value, pattern, lineFor);
        }
        return super.query(content, dialect, pattern, flags);
    }
}

// Convert a jsonpath-plus "path" string ($['users'][0]['name']) into the
// segment array shape that jsonc-parser's findNodeAtLocation accepts
// (['users', 0, 'name']).
function pathToSegments(path: string): Array<string | number> {
    const segments: Array<string | number> = [];
    const re = /\['([^']*)'\]|\[(\d+)\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(path)) !== null) {
        if (m[1] !== undefined) segments.push(m[1]);
        else segments.push(Number(m[2]));
    }
    return segments;
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
