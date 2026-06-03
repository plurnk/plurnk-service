import type { MimeSymbol, SymbolKind } from "../types.ts";
import type { TreeSitterNode } from "../TreeSitterExtractor.ts";

// OCaml SPEC §3 mapping via tree-sitter-ocaml.
//
//   module_definition           → module (module M = struct ... end)
//   module_type_definition      → interface (signature)
//   type_definition             → class (record / variant) or type (alias)
//   let_binding (top-level let) → function (with params) or constant
//   value_definition            → constant/variable for module-level
//   class_definition            → class
//   exception_definition        → class
//   signature                   → interface
export function extract(root: TreeSitterNode, _content: string): MimeSymbol[] {
    const out: MimeSymbol[] = [];
    walk(root, out, /*inModule*/ false);
    return out;
}

function walk(node: TreeSitterNode, out: MimeSymbol[], _inModule: boolean): void {
    for (let i = 0; i < node.namedChildCount; i += 1) {
        const child = node.namedChild(i);
        if (!child) continue;
        dispatch(child, out);
    }
}

function dispatch(node: TreeSitterNode, out: MimeSymbol[]): void {
    switch (node.type) {
        case "module_definition": {
            const binding = firstNamedOfType(node, "module_binding");
            if (binding) {
                const name = firstNamedOfType(binding, "module_name");
                if (name) push(out, "module", name.text, node);
                // Recurse into the structure body to find nested types/lets.
                const struct = firstNamedOfTypeAnywhere(binding, "structure");
                if (struct) walk(struct, out, true);
            }
            return;
        }
        case "module_type_definition": {
            const binding = firstNamedOfType(node, "module_type_binding");
            if (binding) {
                const name = firstNamedOfType(binding, "module_type_name");
                if (name) push(out, "interface", name.text, node);
            }
            return;
        }
        case "type_definition": {
            // Multiple type bindings: type t = ... and u = ...
            for (let i = 0; i < node.namedChildCount; i += 1) {
                const child = node.namedChild(i);
                if (!child) continue;
                if (child.type === "type_binding") {
                    const name = firstNamedOfType(child, "type_constructor");
                    if (name) {
                        // Discriminate: record/variant → class; alias → type
                        const isRecord = firstNamedOfTypeAnywhere(child, "record_declaration") !== null;
                        const isVariant = firstNamedOfTypeAnywhere(child, "variant_declaration") !== null;
                        push(out, (isRecord || isVariant) ? "class" : "type", name.text, child);
                    }
                }
            }
            return;
        }
        case "value_definition": {
            // value_definition: let id [params] = expr
            for (let i = 0; i < node.namedChildCount; i += 1) {
                const child = node.namedChild(i);
                if (!child) continue;
                if (child.type === "let_binding") {
                    const id = firstNamedOfType(child, "value_name");
                    if (!id) continue;
                    const params = extractOcamlParams(child);
                    const kind: SymbolKind = params.length > 0 ? "function" : "constant";
                    if (kind === "function") {
                        out.push({
                            name: id.text,
                            kind,
                            line: child.startPosition.row + 1,
                            endLine: child.endPosition.row + 1,
                            params,
                        });
                    } else {
                        push(out, "constant", id.text, child);
                    }
                }
            }
            return;
        }
        case "class_definition": {
            const binding = firstNamedOfType(node, "class_binding");
            if (binding) {
                const name = firstNamedOfType(binding, "class_name");
                if (name) push(out, "class", name.text, node);
            }
            return;
        }
        case "exception_definition": {
            // exception_definition → constructor_declaration → constructor_name
            const name = firstNamedOfTypeAnywhere(node, "constructor_name");
            if (name) push(out, "class", name.text, node);
            return;
        }
        default:
            return;
    }
}

function firstNamedOfType(node: TreeSitterNode, type: string): TreeSitterNode | null {
    for (let i = 0; i < node.namedChildCount; i += 1) {
        const child = node.namedChild(i);
        if (child && child.type === type) return child;
    }
    return null;
}

// DFS-find first descendant of `type`.
function firstNamedOfTypeAnywhere(node: TreeSitterNode, type: string): TreeSitterNode | null {
    const stack: TreeSitterNode[] = [node];
    while (stack.length > 0) {
        const cur = stack.pop()!;
        if (cur.type === type) return cur;
        for (let i = 0; i < cur.namedChildCount; i += 1) {
            const child = cur.namedChild(i);
            if (child) stack.push(child);
        }
    }
    return null;
}

function extractOcamlParams(binding: TreeSitterNode): string[] {
    const out: string[] = [];
    for (let i = 0; i < binding.namedChildCount; i += 1) {
        const child = binding.namedChild(i);
        if (!child) continue;
        if (child.type === "parameter") {
            // parameter wraps a value_pattern or value_name
            const inner = firstNamedOfTypeAnywhere(child, "value_name");
            if (inner) out.push(inner.text);
            else out.push(child.text);
        }
    }
    return out;
}

function push(
    out: MimeSymbol[],
    kind: SymbolKind,
    name: string,
    node: TreeSitterNode,
): void {
    out.push({
        name,
        kind,
        line: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
    });
}
