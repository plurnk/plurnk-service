import type { MimeSymbol, SymbolKind } from "../types.ts";
import type { TreeSitterNode } from "../TreeSitterExtractor.ts";

// Rust SPEC §3 mapping via tree-sitter-rust.
//
//   function_item         → function (or method inside impl_item body)
//   struct_item           → class
//   enum_item             → enum
//   trait_item            → interface (recurse into body for trait fns as method)
//   impl_item             → recurse into body; function_items inside become method
//   mod_item              → module (recurse)
//   const_item            → constant
//   static_item           → constant
//   type_item             → type
//   union_item            → class
//   macro_definition      → function
//
// Container semantics (issue #18): impl blocks (the impl'd type name), trait
// bodies (the trait name), and mod blocks (the mod name) are containers —
// items inside carry the dotted path of enclosing scope names. `container`
// is the path; `inImplOrTrait` stays a separate flag because mod members
// keep the function kind.
export function extract(root: TreeSitterNode, _content: string): MimeSymbol[] {
    const out: MimeSymbol[] = [];
    walk(root, out, "", /*inImplOrTrait*/ false);
    return out;
}

function walk(node: TreeSitterNode, out: MimeSymbol[], container: string, inImplOrTrait: boolean): void {
    for (let i = 0; i < node.namedChildCount; i += 1) {
        const child = node.namedChild(i);
        if (!child) continue;
        dispatch(child, out, container, inImplOrTrait);
    }
}

function joined(container: string, name: string): string {
    return container.length > 0 ? `${container}.${name}` : name;
}

function dispatch(node: TreeSitterNode, out: MimeSymbol[], container: string, inImplOrTrait: boolean): void {
    switch (node.type) {
        case "function_item":
        case "function_signature_item": {
            const name = childFieldText(node, "name");
            if (!name) return;
            out.push({
                name,
                kind: inImplOrTrait ? "method" : "function",
                ...position(node),
                ...(container.length > 0 && { container }),
                params: extractParams(node.childForFieldName("parameters")),
            });
            return;
        }
        case "struct_item":
        case "union_item": {
            const name = childFieldText(node, "name");
            if (name) push(out, "class", name, node, container);
            return;
        }
        case "enum_item": {
            const name = childFieldText(node, "name");
            if (name) push(out, "enum", name, node, container);
            return;
        }
        case "trait_item": {
            const name = childFieldText(node, "name");
            if (name) push(out, "interface", name, node, container);
            const body = node.childForFieldName("body");
            if (body) walk(body, out, name ? joined(container, name) : container, true);
            return;
        }
        case "impl_item": {
            // impl blocks don't produce a symbol themselves — they decorate
            // an existing type. Recurse into the body so methods inside become
            // method symbols carrying the impl'd type name as container.
            const typeName = implTypeName(node.childForFieldName("type"));
            const body = node.childForFieldName("body");
            if (body) walk(body, out, typeName ? joined(container, typeName) : container, true);
            return;
        }
        case "mod_item": {
            const name = childFieldText(node, "name");
            if (!name) return;
            push(out, "module", name, node, container);
            const body = node.childForFieldName("body");
            if (body) walk(body, out, joined(container, name), false);
            return;
        }
        case "const_item":
        case "static_item": {
            const name = childFieldText(node, "name");
            if (name) push(out, "constant", name, node, container);
            return;
        }
        case "type_item": {
            const name = childFieldText(node, "name");
            if (name) push(out, "type", name, node, container);
            return;
        }
        case "macro_definition": {
            const name = childFieldText(node, "name");
            if (name) push(out, "function", name, node, container);
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

// impl_item's `type` field: type_identifier directly, generic_type wrapping
// one (`impl<T> Wrap<T>`), or scoped_type_identifier (`impl crate::Foo`).
function implTypeName(node: TreeSitterNode | null): string | null {
    if (!node) return null;
    if (node.type === "type_identifier") return node.text;
    if (node.type === "generic_type" || node.type === "scoped_type_identifier") {
        for (let i = 0; i < node.namedChildCount; i += 1) {
            const child = node.namedChild(i);
            if (child?.type === "type_identifier") return child.text;
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
        if (child.type === "self_parameter") {
            out.push("self");
            continue;
        }
        if (child.type === "parameter") {
            // parameter has a "pattern" field that is usually an identifier.
            const pat = child.childForFieldName("pattern");
            if (pat) {
                if (pat.type === "identifier") out.push(pat.text);
                else {
                    // mut x, ref x — find first identifier
                    for (let j = 0; j < pat.namedChildCount; j += 1) {
                        const sub = pat.namedChild(j);
                        if (sub && sub.type === "identifier") {
                            out.push(sub.text);
                            break;
                        }
                    }
                }
            }
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

function push(out: MimeSymbol[], kind: SymbolKind, name: string, node: TreeSitterNode, container = ""): void {
    out.push({
        name,
        kind,
        ...position(node),
        ...(container.length > 0 && { container }),
    });
}

export { refsQuery } from "./queries/rust.ts";
