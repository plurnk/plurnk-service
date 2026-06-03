import type { MimeSymbol, SymbolKind } from "../types.ts";
import type { TreeSitterNode } from "../TreeSitterExtractor.ts";

// Dart SPEC §3 mapping via tree-sitter-dart.
//
//   class_definition      → class (recurse, inClass=true)
//   mixin_declaration     → class
//   extension_declaration → class
//   enum_declaration      → enum + constants
//   function_signature    → function (top-level) / method (in class via method_signature)
//   method_signature      → unwrap inner function_signature → method
//   declaration in class  → field per initialized_identifier
//   getter_signature      → method
//   setter_signature      → method
//   constructor_signature → method
//   type_alias            → type
export function extract(root: TreeSitterNode, _content: string): MimeSymbol[] {
    const out: MimeSymbol[] = [];
    walk(root, out, /*inClass*/ false);
    return out;
}

function walk(node: TreeSitterNode, out: MimeSymbol[], inClass: boolean): void {
    for (let i = 0; i < node.namedChildCount; i += 1) {
        const child = node.namedChild(i);
        if (!child) continue;
        dispatch(child, out, inClass);
    }
}

function dispatch(node: TreeSitterNode, out: MimeSymbol[], inClass: boolean): void {
    switch (node.type) {
        case "class_definition":
        case "mixin_declaration":
        case "extension_declaration": {
            const name = childFieldText(node, "name") ?? firstIdentifierText(node);
            if (!name) return;
            push(out, "class", name, node);
            const body = node.childForFieldName("body") ?? findChildOfType(node, "class_body");
            if (body) walk(body, out, true);
            return;
        }
        case "enum_declaration": {
            const name = firstIdentifierText(node);
            if (name) push(out, "enum", name, node);
            // enum constants are bare identifiers inside the enum body.
            for (let i = 0; i < node.namedChildCount; i += 1) {
                const child = node.namedChild(i);
                if (!child) continue;
                if (child.type === "enum_constant") {
                    const ename = firstIdentifierText(child);
                    if (ename) push(out, "constant", ename, child);
                }
            }
            return;
        }
        case "function_signature": {
            const name = childFieldText(node, "name");
            if (!name) return;
            out.push({
                name,
                kind: inClass ? "method" : "function",
                line: node.startPosition.row + 1,
                endLine: node.endPosition.row + 1,
                params: extractParams(findChildOfType(node, "formal_parameter_list")),
            });
            return;
        }
        case "method_signature": {
            // method_signature wraps function_signature / getter_signature /
            // setter_signature / constructor_signature.
            for (let i = 0; i < node.namedChildCount; i += 1) {
                const child = node.namedChild(i);
                if (!child) continue;
                if (child.type === "function_signature"
                    || child.type === "getter_signature"
                    || child.type === "setter_signature"
                    || child.type === "constructor_signature"
                    || child.type === "factory_constructor_signature") {
                    const name = childFieldText(child, "name") ?? firstIdentifierText(child);
                    if (name) {
                        out.push({
                            name,
                            kind: "method",
                            line: node.startPosition.row + 1,
                            endLine: node.endPosition.row + 1,
                            params: extractParams(findChildOfType(child, "formal_parameter_list")),
                        });
                    }
                }
            }
            return;
        }
        case "declaration": {
            // class-body field declaration: type_identifier + initialized_identifier_list
            const list = findChildOfType(node, "initialized_identifier_list");
            if (list) {
                for (let i = 0; i < list.namedChildCount; i += 1) {
                    const child = list.namedChild(i);
                    if (!child) continue;
                    if (child.type === "initialized_identifier") {
                        const name = firstIdentifierText(child);
                        if (name) push(out, inClass ? "field" : "variable", name, node);
                    }
                }
            }
            return;
        }
        case "type_alias": {
            const name = firstIdentifierText(node);
            if (name) push(out, "type", name, node);
            return;
        }
        default:
            return;
    }
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
        if (child.type === "formal_parameter"
            || child.type === "normal_formal_parameter"
            || child.type === "optional_formal_parameters") {
            const name = childFieldText(child, "name") ?? firstIdentifierText(child);
            if (name) out.push(name);
        }
    }
    return out;
}

function push(out: MimeSymbol[], kind: SymbolKind, name: string, node: TreeSitterNode): void {
    out.push({
        name,
        kind,
        line: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
    });
}
