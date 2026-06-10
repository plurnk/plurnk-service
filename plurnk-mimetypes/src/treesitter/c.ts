import type { MimeSymbol, SymbolKind } from "../types.ts";
import type { TreeSitterNode } from "../TreeSitterExtractor.ts";

// C SPEC §3 mapping via tree-sitter-c.
//
//   function_definition  → function (name via declarator chain)
//   struct_specifier     → class (only when named with a body)
//   union_specifier      → class (only when named with a body)
//   enum_specifier       → enum (only when named); enumerator → constant
//   type_definition      → type (typedef)
//   declaration          → variable (file-scope, named, not extern/static-fn-proto)
//
// Container semantics (issue #18): the mapping is flat except enum bodies —
// enumerators of a *named* enum carry the enum name as container.
export function extract(root: TreeSitterNode, _content: string): MimeSymbol[] {
    const out: MimeSymbol[] = [];
    for (let i = 0; i < root.namedChildCount; i += 1) {
        const child = root.namedChild(i);
        if (!child) continue;
        dispatch(child, out);
    }
    return out;
}

function dispatch(node: TreeSitterNode, out: MimeSymbol[]): void {
    switch (node.type) {
        case "function_definition": {
            const name = declaratorName(node.childForFieldName("declarator"));
            if (!name) return;
            out.push({
                name,
                kind: "function",
                ...position(node),
                params: extractParamsFromDeclarator(node.childForFieldName("declarator")),
            });
            return;
        }
        case "struct_specifier":
        case "union_specifier": {
            const name = childFieldText(node, "name");
            const body = node.childForFieldName("body");
            if (name && body) push(out, "class", name, node);
            return;
        }
        case "enum_specifier": {
            const name = childFieldText(node, "name");
            if (name) push(out, "enum", name, node);
            const body = node.childForFieldName("body");
            if (body) {
                for (let i = 0; i < body.namedChildCount; i += 1) {
                    const child = body.namedChild(i);
                    if (child && child.type === "enumerator") {
                        const ename = childFieldText(child, "name") ?? firstIdentifierText(child);
                        if (ename) push(out, "constant", ename, child, name ?? "");
                    }
                }
            }
            return;
        }
        case "type_definition": {
            // typedef <type> <name>; the declarator's identifier is the type name.
            const declarator = node.childForFieldName("declarator");
            const name = declarator ? declaratorName(declarator) : null;
            if (name) push(out, "type", name, node);
            return;
        }
        case "declaration": {
            // File-scope variable declaration: skip function prototypes.
            // Heuristic: if the declarator is a function_declarator, it's a
            // prototype — don't surface (the definition will, if present).
            const declarator = node.childForFieldName("declarator");
            if (!declarator) return;
            if (declarator.type === "function_declarator") return;
            const name = declaratorName(declarator);
            if (name) push(out, "variable", name, node);
            return;
        }
        default:
            return;
    }
}

// Unwrap pointer/array/parenthesized declarators down to the identifier.
function declaratorName(node: TreeSitterNode | null): string | null {
    if (!node) return null;
    if (node.type === "identifier" || node.type === "field_identifier"
        || node.type === "type_identifier") {
        return node.text;
    }
    if (node.type === "function_declarator" || node.type === "pointer_declarator"
        || node.type === "array_declarator" || node.type === "parenthesized_declarator"
        || node.type === "init_declarator") {
        return declaratorName(node.childForFieldName("declarator"));
    }
    return firstIdentifierText(node);
}

function extractParamsFromDeclarator(node: TreeSitterNode | null): string[] {
    if (!node) return [];
    if (node.type === "function_declarator") {
        const params = node.childForFieldName("parameters");
        if (!params) return [];
        const out: string[] = [];
        for (let i = 0; i < params.namedChildCount; i += 1) {
            const child = params.namedChild(i);
            if (!child) continue;
            if (child.type === "parameter_declaration") {
                const decl = child.childForFieldName("declarator");
                const name = declaratorName(decl);
                if (name) out.push(name);
            }
        }
        return out;
    }
    // Unwrap one level if pointer/parenthesized wraps a function_declarator.
    return extractParamsFromDeclarator(node.childForFieldName("declarator"));
}

function childFieldText(node: TreeSitterNode, field: string): string | null {
    const child = node.childForFieldName(field);
    return child ? child.text : null;
}

function firstIdentifierText(node: TreeSitterNode): string | null {
    for (let i = 0; i < node.namedChildCount; i += 1) {
        const child = node.namedChild(i);
        if (!child) continue;
        if (child.type === "identifier" || child.type === "type_identifier"
            || child.type === "field_identifier") return child.text;
    }
    return null;
}

function position(node: TreeSitterNode): Pick<MimeSymbol, "line" | "endLine" | "column" | "endColumn"> {
    return {
        line: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        column: node.startPosition.column + 1,
        endColumn: node.endPosition.column + 1,
    };
}

function push(out: MimeSymbol[], kind: SymbolKind, name: string, node: TreeSitterNode, container = ""): void {
    out.push({
        name,
        kind,
        ...position(node),
        ...(container.length > 0 && { container }),
    });
}
