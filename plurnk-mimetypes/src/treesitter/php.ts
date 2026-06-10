import type { MimeSymbol, SymbolKind } from "../types.ts";
import type { TreeSitterNode } from "../TreeSitterExtractor.ts";

// PHP SPEC §3 mapping via tree-sitter-php.
//
//   namespace_definition    → module (recurse into body)
//   class_declaration       → class (recurse, inClass=true)
//   interface_declaration   → interface
//   trait_declaration       → class
//   enum_declaration        → enum + enum_case as constant
//   method_declaration      → method
//   function_definition     → function
//   property_declaration    → field (per property_element)
//   const_declaration       → constant (per const_element)
//
// Container semantics (issue #18): symbols inside a namespace/class/interface/
// trait/enum carry the dotted path of enclosing emitted names. Top-level
// symbols carry none.
export function extract(root: TreeSitterNode, _content: string): MimeSymbol[] {
    const out: MimeSymbol[] = [];
    walk(root, out, "");
    return out;
}

function walk(node: TreeSitterNode, out: MimeSymbol[], container: string): void {
    for (let i = 0; i < node.namedChildCount; i += 1) {
        const child = node.namedChild(i);
        if (!child) continue;
        dispatch(child, out, container);
    }
}

function dispatch(node: TreeSitterNode, out: MimeSymbol[], container: string): void {
    switch (node.type) {
        case "namespace_definition": {
            const name = childFieldText(node, "name");
            if (name) push(out, "module", name, node, container);
            const body = node.childForFieldName("body");
            const inner = name
                ? (container.length > 0 ? `${container}.${name}` : name)
                : container;
            if (body) walk(body, out, inner);
            return;
        }
        case "class_declaration":
        case "trait_declaration": {
            const name = childFieldText(node, "name");
            if (!name) return;
            push(out, "class", name, node, container);
            const body = node.childForFieldName("body");
            if (body) walk(body, out, container.length > 0 ? `${container}.${name}` : name);
            return;
        }
        case "interface_declaration": {
            const name = childFieldText(node, "name");
            if (!name) return;
            push(out, "interface", name, node, container);
            const body = node.childForFieldName("body");
            if (body) walk(body, out, container.length > 0 ? `${container}.${name}` : name);
            return;
        }
        case "enum_declaration": {
            const name = childFieldText(node, "name");
            if (!name) return;
            push(out, "enum", name, node, container);
            const body = node.childForFieldName("body");
            if (body) {
                const inner = container.length > 0 ? `${container}.${name}` : name;
                for (let i = 0; i < body.namedChildCount; i += 1) {
                    const child = body.namedChild(i);
                    if (!child) continue;
                    if (child.type === "enum_case") {
                        const ename = childFieldText(child, "name");
                        if (ename) push(out, "constant", ename, child, inner);
                    }
                }
            }
            return;
        }
        case "function_definition": {
            const name = childFieldText(node, "name");
            if (!name) return;
            out.push({
                name,
                kind: "function",
                line: node.startPosition.row + 1,
                endLine: node.endPosition.row + 1,
                column: node.startPosition.column + 1,
                endColumn: node.endPosition.column + 1,
                ...(container.length > 0 && { container }),
                params: extractParams(node.childForFieldName("parameters")),
            });
            return;
        }
        case "method_declaration": {
            const name = childFieldText(node, "name");
            if (!name) return;
            out.push({
                name,
                kind: "method",
                line: node.startPosition.row + 1,
                endLine: node.endPosition.row + 1,
                column: node.startPosition.column + 1,
                endColumn: node.endPosition.column + 1,
                ...(container.length > 0 && { container }),
                params: extractParams(node.childForFieldName("parameters")),
            });
            return;
        }
        case "property_declaration": {
            // property_declaration → property_element (per item) → variable_name
            for (let i = 0; i < node.namedChildCount; i += 1) {
                const child = node.namedChild(i);
                if (!child) continue;
                if (child.type === "property_element") {
                    const vname = firstVariableName(child);
                    if (vname) push(out, "field", vname, child, container);
                }
            }
            return;
        }
        case "const_declaration": {
            for (let i = 0; i < node.namedChildCount; i += 1) {
                const child = node.namedChild(i);
                if (!child) continue;
                if (child.type === "const_element") {
                    const cname = childFieldText(child, "name") ?? firstIdentifierText(child);
                    if (cname) push(out, "constant", cname, child, container);
                }
            }
            return;
        }
        default:
            return;
    }
}

function firstVariableName(node: TreeSitterNode): string | null {
    for (let i = 0; i < node.namedChildCount; i += 1) {
        const child = node.namedChild(i);
        if (!child) continue;
        if (child.type === "variable_name") {
            // variable_name wraps a name node; strip leading $
            return child.text.startsWith("$") ? child.text.slice(1) : child.text;
        }
    }
    return null;
}

function extractParams(parametersNode: TreeSitterNode | null): string[] {
    if (!parametersNode) return [];
    const out: string[] = [];
    for (let i = 0; i < parametersNode.namedChildCount; i += 1) {
        const child = parametersNode.namedChild(i);
        if (!child) continue;
        if (child.type === "simple_parameter" || child.type === "variadic_parameter"
            || child.type === "property_promotion_parameter") {
            const name = childFieldText(child, "name") ?? firstVariableName(child);
            if (name) out.push(name);
        }
    }
    return out;
}

function childFieldText(node: TreeSitterNode, field: string): string | null {
    const child = node.childForFieldName(field);
    if (!child) return null;
    if (child.type === "variable_name") {
        return child.text.startsWith("$") ? child.text.slice(1) : child.text;
    }
    return child.text;
}

function firstIdentifierText(node: TreeSitterNode): string | null {
    for (let i = 0; i < node.namedChildCount; i += 1) {
        const child = node.namedChild(i);
        if (!child) continue;
        if (child.type === "name" || child.type === "identifier") return child.text;
    }
    return null;
}

function push(out: MimeSymbol[], kind: SymbolKind, name: string, node: TreeSitterNode, container: string): void {
    out.push({
        name,
        kind,
        line: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        column: node.startPosition.column + 1,
        endColumn: node.endPosition.column + 1,
        ...(container.length > 0 && { container }),
    });
}
