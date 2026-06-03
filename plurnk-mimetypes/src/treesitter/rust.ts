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
export function extract(root: TreeSitterNode, _content: string): MimeSymbol[] {
    const out: MimeSymbol[] = [];
    walk(root, out, /*inImplOrTrait*/ false);
    return out;
}

function walk(node: TreeSitterNode, out: MimeSymbol[], inImplOrTrait: boolean): void {
    for (let i = 0; i < node.namedChildCount; i += 1) {
        const child = node.namedChild(i);
        if (!child) continue;
        dispatch(child, out, inImplOrTrait);
    }
}

function dispatch(node: TreeSitterNode, out: MimeSymbol[], inImplOrTrait: boolean): void {
    switch (node.type) {
        case "function_item":
        case "function_signature_item": {
            const name = childFieldText(node, "name");
            if (!name) return;
            out.push({
                name,
                kind: inImplOrTrait ? "method" : "function",
                line: node.startPosition.row + 1,
                endLine: node.endPosition.row + 1,
                params: extractParams(node.childForFieldName("parameters")),
            });
            return;
        }
        case "struct_item":
        case "union_item": {
            const name = childFieldText(node, "name");
            if (name) push(out, "class", name, node);
            return;
        }
        case "enum_item": {
            const name = childFieldText(node, "name");
            if (name) push(out, "enum", name, node);
            return;
        }
        case "trait_item": {
            const name = childFieldText(node, "name");
            if (name) push(out, "interface", name, node);
            const body = node.childForFieldName("body");
            if (body) walk(body, out, true);
            return;
        }
        case "impl_item": {
            // impl blocks don't produce a symbol themselves — they decorate
            // an existing type. Recurse into the body so methods inside become
            // method symbols.
            const body = node.childForFieldName("body");
            if (body) walk(body, out, true);
            return;
        }
        case "mod_item": {
            const name = childFieldText(node, "name");
            if (!name) return;
            push(out, "module", name, node);
            const body = node.childForFieldName("body");
            if (body) walk(body, out, false);
            return;
        }
        case "const_item":
        case "static_item": {
            const name = childFieldText(node, "name");
            if (name) push(out, "constant", name, node);
            return;
        }
        case "type_item": {
            const name = childFieldText(node, "name");
            if (name) push(out, "type", name, node);
            return;
        }
        case "macro_definition": {
            const name = childFieldText(node, "name");
            if (name) push(out, "function", name, node);
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

function push(out: MimeSymbol[], kind: SymbolKind, name: string, node: TreeSitterNode): void {
    out.push({
        name,
        kind,
        line: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
    });
}
