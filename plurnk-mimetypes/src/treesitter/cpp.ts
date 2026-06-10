import type { MimeSymbol, SymbolKind } from "../types.ts";
import type { TreeSitterNode } from "../TreeSitterExtractor.ts";

// C++ SPEC §3 mapping via tree-sitter-cpp.
//
//   function_definition           → function (top-level) / method (in class)
//   class_specifier               → class (recurse into body, inClass=true)
//   struct_specifier              → class
//   union_specifier               → class
//   enum_specifier                → enum + enumerators as constants
//   namespace_definition          → module (recurse)
//   template_declaration          → unwrap and dispatch on inner
//   type_definition / alias_decl  → type
//   field_declaration             → field (in class)
//   declaration (file-scope var)  → variable
//
// Container semantics (issue #18): classes/structs/unions, namespaces, and
// named enums are containers — members carry the dotted path of enclosing
// emitted scope names. `container` is the path; `inClass` stays a separate
// flag because namespace members keep function/variable kinds.
export function extract(root: TreeSitterNode, _content: string): MimeSymbol[] {
    const out: MimeSymbol[] = [];
    walk(root, out, "", /*inClass*/ false);
    return out;
}

function walk(node: TreeSitterNode, out: MimeSymbol[], container: string, inClass: boolean): void {
    for (let i = 0; i < node.namedChildCount; i += 1) {
        const child = node.namedChild(i);
        if (!child) continue;
        dispatch(child, out, container, inClass);
    }
}

function joined(container: string, name: string): string {
    return container.length > 0 ? `${container}.${name}` : name;
}

function dispatch(node: TreeSitterNode, out: MimeSymbol[], container: string, inClass: boolean): void {
    switch (node.type) {
        case "function_definition": {
            const name = declaratorName(node.childForFieldName("declarator"));
            if (!name) return;
            out.push({
                name,
                kind: inClass ? "method" : "function",
                ...position(node),
                ...(container.length > 0 && { container }),
                params: extractParamsFromDeclarator(node.childForFieldName("declarator")),
            });
            return;
        }
        case "class_specifier":
        case "struct_specifier":
        case "union_specifier": {
            const name = childFieldText(node, "name");
            const body = node.childForFieldName("body");
            if (!name || !body) return;
            push(out, "class", name, node, container);
            walk(body, out, joined(container, name), true);
            return;
        }
        case "enum_specifier": {
            const name = childFieldText(node, "name");
            if (name) push(out, "enum", name, node, container);
            const body = node.childForFieldName("body");
            if (body) {
                const enumContainer = name ? joined(container, name) : container;
                for (let i = 0; i < body.namedChildCount; i += 1) {
                    const child = body.namedChild(i);
                    if (child && child.type === "enumerator") {
                        const ename = childFieldText(child, "name") ?? firstIdentifierText(child);
                        if (ename) push(out, "constant", ename, child, enumContainer);
                    }
                }
            }
            return;
        }
        case "namespace_definition": {
            const name = childFieldText(node, "name");
            if (name) push(out, "module", name, node, container);
            const body = node.childForFieldName("body");
            if (body) walk(body, out, name ? joined(container, name) : container, false);
            return;
        }
        case "template_declaration": {
            // Find the declaration child and dispatch on it.
            for (let i = 0; i < node.namedChildCount; i += 1) {
                const child = node.namedChild(i);
                if (!child) continue;
                if (child.type === "function_definition" || child.type === "class_specifier"
                    || child.type === "struct_specifier" || child.type === "union_specifier") {
                    dispatch(child, out, container, inClass);
                }
            }
            return;
        }
        case "type_definition":
        case "alias_declaration": {
            const declarator = node.childForFieldName("declarator");
            const name = declarator ? declaratorName(declarator) : childFieldText(node, "name");
            if (name) push(out, "type", name, node, container);
            return;
        }
        case "field_declaration": {
            const declarator = node.childForFieldName("declarator");
            if (!declarator) return;
            // Inside a class, a field_declaration with a function_declarator is
            // a method declaration (out-of-line definition not handled here).
            if (declarator.type === "function_declarator") {
                if (inClass) {
                    const name = declaratorName(declarator);
                    if (name) {
                        out.push({
                            name,
                            kind: "method",
                            ...position(node),
                            ...(container.length > 0 && { container }),
                            params: extractParamsFromDeclarator(declarator),
                        });
                    }
                }
                return;
            }
            const name = declaratorName(declarator);
            if (name) push(out, inClass ? "field" : "variable", name, node, container);
            return;
        }
        case "declaration": {
            const declarator = node.childForFieldName("declarator");
            if (!declarator) return;
            if (declarator.type === "function_declarator") return;
            const name = declaratorName(declarator);
            if (name) push(out, "variable", name, node, container);
            return;
        }
        default:
            return;
    }
}

function declaratorName(node: TreeSitterNode | null): string | null {
    if (!node) return null;
    if (node.type === "identifier" || node.type === "field_identifier"
        || node.type === "type_identifier") return node.text;
    if (node.type === "qualified_identifier") {
        const sub = node.childForFieldName("name");
        if (sub) return declaratorName(sub);
        return firstIdentifierText(node);
    }
    if (node.type === "function_declarator" || node.type === "pointer_declarator"
        || node.type === "reference_declarator" || node.type === "array_declarator"
        || node.type === "parenthesized_declarator" || node.type === "init_declarator") {
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
            if (child.type === "parameter_declaration"
                || child.type === "optional_parameter_declaration") {
                const decl = child.childForFieldName("declarator");
                const name = declaratorName(decl);
                if (name) out.push(name);
            }
        }
        return out;
    }
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
