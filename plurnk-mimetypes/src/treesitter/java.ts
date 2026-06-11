import type { MimeSymbol, SymbolKind } from "../types.ts";
import type { TreeSitterNode } from "../TreeSitterExtractor.ts";

// Java SPEC §3 mapping via tree-sitter-java.
//
//   class_declaration            → class (recurse into body as inClass)
//   interface_declaration        → interface (recurse)
//   enum_declaration             → enum (recurse; enum_constant → constant)
//   record_declaration           → class
//   annotation_type_declaration  → interface
//   method_declaration           → method (inClass) / function (top-level, rare)
//   constructor_declaration      → method
//   field_declaration            → field (per variable_declarator)
//   enum_constant                → constant
//
// Container semantics (issue #18): members carry the dotted path of enclosing
// emitted class/interface/enum names. Top-level symbols carry no container.
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
        case "class_declaration":
        case "record_declaration": {
            const name = childFieldText(node, "name");
            if (!name) return;
            push(out, "class", name, node, container);
            const body = node.childForFieldName("body");
            if (body) walk(body, out, qualify(container, name));
            return;
        }
        case "interface_declaration":
        case "annotation_type_declaration": {
            const name = childFieldText(node, "name");
            if (!name) return;
            push(out, "interface", name, node, container);
            const body = node.childForFieldName("body");
            if (body) walk(body, out, qualify(container, name));
            return;
        }
        case "enum_declaration": {
            const name = childFieldText(node, "name");
            if (!name) return;
            push(out, "enum", name, node, container);
            const body = node.childForFieldName("body");
            if (body) walk(body, out, qualify(container, name));
            return;
        }
        case "method_declaration":
        case "constructor_declaration": {
            const name = childFieldText(node, "name");
            if (!name) return;
            const params = extractParams(node.childForFieldName("parameters"));
            out.push({
                name,
                kind: container.length > 0 ? "method" : "function",
                ...position(node),
                ...(container.length > 0 && { container }),
                params,
            });
            return;
        }
        case "field_declaration": {
            // field_declaration contains one or more variable_declarator children.
            for (let i = 0; i < node.namedChildCount; i += 1) {
                const child = node.namedChild(i);
                if (!child || child.type !== "variable_declarator") continue;
                const name = childFieldText(child, "name");
                if (name) push(out, "field", name, node, container);
            }
            return;
        }
        case "enum_constant": {
            const name = childFieldText(node, "name");
            if (name) push(out, "constant", name, node, container);
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

function extractParams(parametersNode: TreeSitterNode | null): string[] {
    if (!parametersNode) return [];
    const out: string[] = [];
    for (let i = 0; i < parametersNode.namedChildCount; i += 1) {
        const child = parametersNode.namedChild(i);
        if (!child) continue;
        if (child.type === "formal_parameter" || child.type === "spread_parameter") {
            const name = child.childForFieldName("name");
            if (name) out.push(name.text);
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

export { refsQuery } from "./queries/java.ts";
