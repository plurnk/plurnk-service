import {
    BaseHandler,
    projectJsonToXml,
    queryJsonpathObject,
    QueryParseFailureError,
    TextCoordinates,
} from "@plurnk/plurnk-mimetypes";
import type {
    HandlerContent,
    MimeSymbol,
    QueryDialect,
    QueryMatch,
    TextRegion,
} from "@plurnk/plurnk-mimetypes";
import {
    getNodeValue,
    type Node,
    parse as parseJsonc,
    type ParseError,
    parseTree,
    printParseErrorCode,
} from "jsonc-parser";
import JsonSource from "./JsonSource.ts";

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
        const position = new TextCoordinates(content).positionAtOffset(first.offset);
        throw new SyntaxError(
            `${printParseErrorCode(first.error)} at ${position === null ? `offset ${first.offset}` : `line ${position.line}:${position.column}`}`,
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
        collectKeys(tree, new TextCoordinates(content), symbols, "");
        return symbols;
    }

    // Deep-channel ({§mimetype-channel-architecture}). For JSON, the deep-json IS the parsed value
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
    // regex/glob inherit BaseHandler's defaults against the raw JSON text.
    // xpath inherits the framework's deep-xml projection.
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
            return queryJsonpathObject(value, pattern, regionFor(tree, content));
        }
        return super.query(content, dialect, pattern, flags);
    }

    // deep-xml carries the SAME source lines as jsonpath ({§mimetype-query}): project the
    // parsed value, stamping pk:line from the jsonc offsets via the shared
    // resolver, so xpath-over-deepXml and jsonpath agree. Degrades to the
    // framework default (positions absent) when the content doesn't parse.
    override deepXml(content: HandlerContent): Promise<string> {
        if (typeof content !== "string") return super.deepXml(content);
        const allowsRelaxation = this.mimetype === "application/jsonc";
        const tree = parseTree(content, [], { allowTrailingComma: allowsRelaxation, disallowComments: !allowsRelaxation });
        if (tree === undefined) return super.deepXml(content);
        return Promise.resolve(projectJsonToXml(this.deepJson(content), "root", spanFor(tree, content), "value"));
    }
}

// {§slice-semantics-compose-pattern} — both projections retain value coordinates,
// including lexical quotes and escapes, without widening to the containing property.
function spanFor(tree: Node, content: string): (pointer: string) => { line: number; endLine: number; column?: number; endColumn?: number } | undefined {
    const resolve = regionFor(tree, content);
    return (pointer) => {
        const region = resolve(pointer)?.[0];
        return region === undefined ? undefined : {
            line: region.startLine, endLine: region.endLine, column: region.startColumn, endColumn: region.endColumn,
        };
    };
}

function regionFor(
    tree: Node,
    content: string,
): (pointer: string) => readonly TextRegion[] | undefined {
    const source = new JsonSource(content, tree);
    return (pointer) => {
        const region = source.region(pointer);
        return region === undefined ? undefined : [region];
    };
}

// Walk a jsonc-parser Node tree and emit a field symbol for every property
// key encountered at every depth. Each property node has a `children` pair:
// [keyNode, valueNode]. The keyNode's offset gives the source position.
//
// `container` is the dotted path of enclosing emitted keys (SPEC §3): keys
// inside this property's value carry the path extended by this key. Array
// indices contribute nothing — arrays recurse with the path unchanged.
function collectKeys(
    node: Node,
    coordinates: TextCoordinates,
    into: MimeSymbol[],
    container: string,
): void {
    if (node.type === "property" && node.children && node.children.length >= 2) {
        const keyNode = node.children[0];
        let inner = container;
        if (keyNode.type === "string" && typeof keyNode.value === "string") {
            const region = coordinates.regionFromOffsets(keyNode.offset, keyNode.offset + keyNode.length);
            if (region === null) throw new Error("JSON key has no addressable source region");
            into.push({
                name: keyNode.value,
                kind: "field",
                line: region.startLine,
                endLine: region.endLine,
                column: region.startColumn,
                endColumn: region.endColumn,
                ...(container.length > 0 && { container }),
            });
            inner = container.length > 0 ? `${container}.${keyNode.value}` : keyNode.value;
        }
        // Recurse into the value to find nested keys.
        const valueNode = node.children[1];
        if (valueNode) collectKeys(valueNode, coordinates, into, inner);
        return;
    }

    // Objects, arrays, and the root all recurse through children.
    if (node.children) {
        for (const child of node.children) {
            collectKeys(child, coordinates, into, container);
        }
    }
}
