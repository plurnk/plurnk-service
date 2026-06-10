import type { MimeSymbol, SymbolKind } from "../types.ts";
import type { TreeSitterNode } from "../TreeSitterExtractor.ts";
import {
    walk as walkJs,
    dispatch as dispatchJs,
    childFieldText,
    extractParams,
    position,
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
//
// Container semantics (issue #18): symbols inside a class, interface, enum,
// or namespace/module carry the dotted path of enclosing emitted scope names.
// Top-level symbols carry no container.
export function extract(root: TreeSitterNode, _content: string): MimeSymbol[] {
    const out: MimeSymbol[] = [];
    walk(root, out, "");
    return out;
}

function walk(node: TreeSitterNode, out: MimeSymbol[], container: string): void {
    for (let i = 0; i < node.namedChildCount; i += 1) {
        const child = node.namedChild(i);
        if (!child) continue;
        // TypeScript wraps namespace/module declarations in expression_statement
        // at top level — peek through.
        if (child.type === "expression_statement") {
            const inner = child.namedChild(0);
            if (inner) dispatch(inner, out, container);
            continue;
        }
        dispatch(child, out, container);
    }
}

function dispatch(node: TreeSitterNode, out: MimeSymbol[], container: string): void {
    switch (node.type) {
        case "interface_declaration": {
            const name = childFieldText(node, "name");
            if (!name) return;
            push(out, "interface", name, node, container);
            const body = node.childForFieldName("body");
            if (body) walk(body, out, qualify(container, name));
            return;
        }
        case "type_alias_declaration": {
            const name = childFieldText(node, "name");
            if (name) push(out, "type", name, node, container);
            return;
        }
        case "enum_declaration": {
            const name = childFieldText(node, "name");
            if (name) push(out, "enum", name, node, container);
            const body = node.childForFieldName("body");
            if (body && name) {
                const inner = qualify(container, name);
                for (let i = 0; i < body.namedChildCount; i += 1) {
                    const child = body.namedChild(i);
                    if (!child) continue;
                    if (child.type === "enum_assignment" || child.type === "property_identifier") {
                        const ename = child.type === "enum_assignment"
                            ? childFieldText(child, "name")
                            : child.text;
                        if (ename) push(out, "constant", ename, child, inner);
                    }
                }
            }
            return;
        }
        case "internal_module":
        case "module": {
            const name = childFieldText(node, "name");
            if (name) push(out, "module", name, node, container);
            const body = node.childForFieldName("body");
            if (body) walk(body, out, name ? qualify(container, name) : container);
            return;
        }
        case "ambient_declaration": {
            // declare <something>; unwrap to inner.
            for (let i = 0; i < node.namedChildCount; i += 1) {
                const child = node.namedChild(i);
                if (child) dispatch(child, out, container);
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
                    ...position(node),
                    ...(container.length > 0 && { container }),
                    params: extractParams(node.childForFieldName("parameters")),
                });
            }
            return;
        }
        case "property_signature": {
            // Inside an interface body: a field on the interface.
            const name = childFieldText(node, "name");
            if (name) push(out, "field", name, node, container);
            return;
        }
        default:
            // Fall through to the JavaScript dispatch for JS-shared node types
            // (function_declaration, class_declaration, lexical_declaration,
            // export_statement, etc.).
            dispatchJs(node, out, container);
            return;
    }
}

function qualify(container: string, name: string): string {
    return container.length > 0 ? `${container}.${name}` : name;
}

function push(out: MimeSymbol[], kind: SymbolKind, name: string, node: TreeSitterNode, container: string): void {
    out.push({
        name,
        kind,
        ...position(node),
        ...(container.length > 0 && { container }),
    });
}

// Re-export walkJs for symmetry (not used directly).
export { walkJs };
