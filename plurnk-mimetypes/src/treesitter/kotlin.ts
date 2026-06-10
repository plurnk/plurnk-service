import type { MimeSymbol, SymbolKind } from "../types.ts";
import type { TreeSitterNode } from "../TreeSitterExtractor.ts";

// Kotlin SPEC §3 mapping via @tree-sitter-grammars/tree-sitter-kotlin.
//
//   package_header                → module
//   class_declaration             → class (recurse, inClass=true)
//   interface_declaration         → interface
//   object_declaration            → class (singleton)
//   enum_class_declaration        → enum
//   function_declaration          → function (top) / method (in class)
//   property_declaration          → field (in class) / variable or constant (top)
//   type_alias                    → type
//
// Container semantics (issue #18): members carry the dotted path of enclosing
// emitted class/object/interface/enum names. Top-level symbols carry no
// container (package_header has no body, so it never contains).
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
        case "package_header": {
            // package x.y.z — surface as a single module entry.
            const qid = findChildOfType(node, "qualified_identifier")
                ?? findChildOfType(node, "identifier");
            if (qid) push(out, "module", qid.text, node, container);
            return;
        }
        case "class_declaration":
        case "object_declaration": {
            const name = childFieldText(node, "name");
            if (!name) return;
            push(out, "class", name, node, container);
            const body = findChildOfType(node, "class_body")
                ?? findChildOfType(node, "object_body");
            if (body) walk(body, out, qualify(container, name));
            return;
        }
        case "interface_declaration": {
            const name = childFieldText(node, "name");
            if (!name) return;
            push(out, "interface", name, node, container);
            const body = findChildOfType(node, "interface_body")
                ?? findChildOfType(node, "class_body");
            if (body) walk(body, out, qualify(container, name));
            return;
        }
        case "enum_class_declaration":
        case "enum_declaration": {
            const name = childFieldText(node, "name");
            if (name) push(out, "enum", name, node, container);
            // Surface enum entries as constants.
            const body = findChildOfType(node, "enum_class_body")
                ?? findChildOfType(node, "class_body");
            if (body && name) {
                const inner = qualify(container, name);
                for (let i = 0; i < body.namedChildCount; i += 1) {
                    const child = body.namedChild(i);
                    if (!child) continue;
                    if (child.type === "enum_entry") {
                        const ename = firstIdentifierText(child);
                        if (ename) push(out, "constant", ename, child, inner);
                    }
                }
            }
            return;
        }
        case "function_declaration": {
            const name = childFieldText(node, "name");
            if (!name) return;
            out.push({
                name,
                kind: container.length > 0 ? "method" : "function",
                ...position(node),
                ...(container.length > 0 && { container }),
                params: extractParams(findChildOfType(node, "function_value_parameters")),
            });
            return;
        }
        case "property_declaration": {
            const varDecl = findChildOfType(node, "variable_declaration");
            const name = varDecl ? firstIdentifierText(varDecl) : firstIdentifierText(node);
            if (!name) return;
            if (container.length > 0) {
                push(out, "field", name, node, container);
            } else {
                // val/var distinction at top level: val → constant, var → variable.
                const isVal = node.text.trimStart().startsWith("val");
                push(out, isVal ? "constant" : "variable", name, node, container);
            }
            return;
        }
        case "type_alias": {
            const name = childFieldText(node, "name") ?? firstIdentifierText(node);
            if (name) push(out, "type", name, node, container);
            return;
        }
        default:
            return;
    }
}

function qualify(container: string, name: string): string {
    return container.length > 0 ? `${container}.${name}` : name;
}

function position(node: TreeSitterNode): Pick<MimeSymbol, "line" | "endLine" | "column" | "endColumn"> {
    return {
        line: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        column: node.startPosition.column + 1,
        endColumn: node.endPosition.column + 1,
    };
}

function childFieldText(node: TreeSitterNode, field: string): string | null {
    const child = node.childForFieldName(field);
    return child ? child.text : null;
}

function findChildOfType(node: TreeSitterNode, type: string): TreeSitterNode | null {
    for (let i = 0; i < node.namedChildCount; i += 1) {
        const child = node.namedChild(i);
        if (child && child.type === type) return child;
    }
    return null;
}

function firstIdentifierText(node: TreeSitterNode): string | null {
    for (let i = 0; i < node.namedChildCount; i += 1) {
        const child = node.namedChild(i);
        if (!child) continue;
        if (child.type === "identifier") return child.text;
    }
    return null;
}

function extractParams(parametersNode: TreeSitterNode | null): string[] {
    if (!parametersNode) return [];
    const out: string[] = [];
    for (let i = 0; i < parametersNode.namedChildCount; i += 1) {
        const child = parametersNode.namedChild(i);
        if (!child) continue;
        if (child.type === "parameter") {
            const name = firstIdentifierText(child);
            if (name) out.push(name);
        }
    }
    return out;
}

function push(out: MimeSymbol[], kind: SymbolKind, name: string, node: TreeSitterNode, container: string): void {
    out.push({
        name,
        kind,
        ...position(node),
        ...(container.length > 0 && { container }),
    });
}
