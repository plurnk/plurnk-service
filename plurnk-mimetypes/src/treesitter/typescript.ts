import type { MimeSymbol, SymbolKind } from "../types.ts";
import type { TreeSitterNode } from "../TreeSitterExtractor.ts";
import {
    walk as walkJs,
    dispatch as dispatchJs,
    childFieldText,
    extractParams,
} from "./javascript.ts";

// TypeScript SPEC §3 mapping via tree-sitter-typescript (and tree-sitter-tsx).
// Extends the JS mapping with interface/type/enum/module declarations.
//
//   interface_declaration   → interface
//   type_alias_declaration  → type
//   enum_declaration        → enum + enum_assignment children as constants
//   internal_module/module  → module (recurse)
//   abstract_class_declaration → class (handled in JS dispatch)
//   ambient_declaration     → unwrap and dispatch
export function extract(root: TreeSitterNode, _content: string): MimeSymbol[] {
    const out: MimeSymbol[] = [];
    walk(root, out, /*inClass*/ false);
    return out;
}

function walk(node: TreeSitterNode, out: MimeSymbol[], inClass: boolean): void {
    for (let i = 0; i < node.namedChildCount; i += 1) {
        const child = node.namedChild(i);
        if (!child) continue;
        // TypeScript wraps namespace/module declarations in expression_statement
        // at top level — peek through.
        if (child.type === "expression_statement") {
            const inner = child.namedChild(0);
            if (inner) dispatch(inner, out, inClass);
            continue;
        }
        dispatch(child, out, inClass);
    }
}

function dispatch(node: TreeSitterNode, out: MimeSymbol[], inClass: boolean): void {
    switch (node.type) {
        case "interface_declaration": {
            const name = childFieldText(node, "name");
            if (!name) return;
            push(out, "interface", name, node);
            const body = node.childForFieldName("body");
            if (body) walk(body, out, true);
            return;
        }
        case "type_alias_declaration": {
            const name = childFieldText(node, "name");
            if (name) push(out, "type", name, node);
            return;
        }
        case "enum_declaration": {
            const name = childFieldText(node, "name");
            if (name) push(out, "enum", name, node);
            const body = node.childForFieldName("body");
            if (body) {
                for (let i = 0; i < body.namedChildCount; i += 1) {
                    const child = body.namedChild(i);
                    if (!child) continue;
                    if (child.type === "enum_assignment" || child.type === "property_identifier") {
                        const ename = child.type === "enum_assignment"
                            ? childFieldText(child, "name")
                            : child.text;
                        if (ename) push(out, "constant", ename, child);
                    }
                }
            }
            return;
        }
        case "internal_module":
        case "module": {
            const name = childFieldText(node, "name");
            if (name) push(out, "module", name, node);
            const body = node.childForFieldName("body");
            if (body) walk(body, out, false);
            return;
        }
        case "ambient_declaration": {
            // declare <something>; unwrap to inner.
            for (let i = 0; i < node.namedChildCount; i += 1) {
                const child = node.namedChild(i);
                if (child) dispatch(child, out, inClass);
            }
            return;
        }
        case "method_signature":
        case "abstract_method_signature": {
            // Inside an interface body: method-shaped signature.
            const name = childFieldText(node, "name");
            if (name) {
                out.push({
                    name,
                    kind: "method",
                    line: node.startPosition.row + 1,
                    endLine: node.endPosition.row + 1,
                    params: extractParams(node.childForFieldName("parameters")),
                });
            }
            return;
        }
        case "property_signature": {
            // Inside an interface body: a field on the interface.
            const name = childFieldText(node, "name");
            if (name) push(out, "field", name, node);
            return;
        }
        default:
            // Fall through to the JavaScript dispatch for JS-shared node types
            // (function_declaration, class_declaration, lexical_declaration,
            // export_statement, etc.).
            dispatchJs(node, out, inClass);
            return;
    }
}

function push(out: MimeSymbol[], kind: SymbolKind, name: string, node: TreeSitterNode): void {
    out.push({
        name,
        kind,
        line: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
    });
}

// Re-export walkJs for symmetry (not used directly).
export { walkJs };
