import type { MimeSymbol, SymbolKind } from "../types.ts";
import type { TreeSitterNode } from "../TreeSitterExtractor.ts";

// Dart SPEC §3 mapping via tree-sitter-dart.
//
//   class_definition      → class (recurse into body as container)
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
//
// Container semantics (issue #18): members inside a class/mixin/extension
// body carry its name (dotted for nesting); enum constants carry the enum
// name. Top-level symbols carry no container.
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
        case "class_definition":
        case "mixin_declaration":
        case "extension_declaration": {
            const name = childFieldText(node, "name") ?? firstIdentifierText(node);
            if (!name) return;
            push(out, "class", name, node, container);
            const body = node.childForFieldName("body") ?? findChildOfType(node, "class_body");
            if (body) walk(body, out, container.length > 0 ? `${container}.${name}` : name);
            return;
        }
        case "enum_declaration": {
            const name = firstIdentifierText(node);
            if (name) push(out, "enum", name, node, container);
            const constContainer = name
                ? (container.length > 0 ? `${container}.${name}` : name)
                : container;
            // enum constants live under the enum_body child, not as direct
            // children of the declaration.
            const body = findChildOfType(node, "enum_body") ?? node;
            for (let i = 0; i < body.namedChildCount; i += 1) {
                const child = body.namedChild(i);
                if (!child) continue;
                if (child.type === "enum_constant") {
                    const ename = firstIdentifierText(child);
                    if (ename) push(out, "constant", ename, child, constContainer);
                }
            }
            return;
        }
        case "function_signature": {
            const name = childFieldText(node, "name");
            if (!name) return;
            out.push({
                name,
                kind: container.length > 0 ? "method" : "function",
                ...positionWithBody(node),
                ...(container.length > 0 && { container }),
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
                            ...positionWithBody(node),
                            ...(container.length > 0 && { container }),
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
                        if (name) push(out, container.length > 0 ? "field" : "variable", name, node, container);
                    }
                }
            }
            return;
        }
        case "type_alias": {
            const name = firstIdentifierText(node);
            if (name) push(out, "type", name, node, container);
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

function position(node: TreeSitterNode): Pick<MimeSymbol, "line" | "endLine" | "column" | "endColumn"> {
    return {
        line: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        column: node.startPosition.column + 1,
        endColumn: node.endPosition.column + 1,
    };
}

// tree-sitter-dart parses a function/method body as a SIBLING of its
// signature (function_signature/method_signature followed by function_body),
// so the signature span alone never covers the body lines. Extend the def's
// end to the body so container resolution lands refs on the method, not the
// enclosing class. Bodyless (abstract) signatures parse as `declaration`
// nodes and never reach here with a function_body sibling.
function positionWithBody(node: TreeSitterNode): Pick<MimeSymbol, "line" | "endLine" | "column" | "endColumn"> {
    const pos = position(node);
    const body = node.nextNamedSibling;
    if (body?.type !== "function_body") return pos;
    return {
        ...pos,
        endLine: body.endPosition.row + 1,
        endColumn: body.endPosition.column + 1,
    };
}

function push(out: MimeSymbol[], kind: SymbolKind, name: string, node: TreeSitterNode, container: string): void {
    out.push({
        name,
        kind,
        ...position(node),
        ...(container.length > 0 && { container }),
    });
}

export { refsQuery } from "./queries/dart.ts";
