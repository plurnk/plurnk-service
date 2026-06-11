import type { MimeSymbol, SymbolKind } from "../types.ts";
import type { TreeSitterNode } from "../TreeSitterExtractor.ts";

// Go SPEC §3 mapping via tree-sitter-go.
//
//   package_clause       → module
//   function_declaration → function
//   method_declaration   → method
//   type_declaration     → contains type_spec; struct_type → class,
//                          interface_type → interface, else → type
//   const_declaration    → constant (per const_spec)
//   var_declaration      → variable (per var_spec)
//
// Container semantics (issue #18): flat — the mapping walks no nested scopes
// and never emits the method receiver type, so no symbol carries a container.
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
        case "package_clause": {
            // package_clause → package_identifier
            for (let i = 0; i < node.namedChildCount; i += 1) {
                const child = node.namedChild(i);
                if (child && child.type === "package_identifier") {
                    push(out, "module", child.text, node);
                    return;
                }
            }
            return;
        }
        case "function_declaration": {
            const name = childFieldText(node, "name");
            if (!name) return;
            out.push({
                name,
                kind: "function",
                ...position(node),
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
                ...position(node),
                params: extractParams(node.childForFieldName("parameters")),
            });
            return;
        }
        case "type_declaration": {
            for (let i = 0; i < node.namedChildCount; i += 1) {
                const spec = node.namedChild(i);
                if (!spec) continue;
                if (spec.type !== "type_spec" && spec.type !== "type_alias") continue;
                const name = childFieldText(spec, "name");
                if (!name) continue;
                const t = spec.childForFieldName("type");
                let kind: SymbolKind = "type";
                if (t) {
                    if (t.type === "struct_type") kind = "class";
                    else if (t.type === "interface_type") kind = "interface";
                }
                push(out, kind, name, spec);
            }
            return;
        }
        case "const_declaration": {
            forEachSpec(node, "const_spec", (spec) => {
                forEachIdentifier(spec, "name", (text, ident) => push(out, "constant", text, ident));
            });
            return;
        }
        case "var_declaration": {
            forEachSpec(node, "var_spec", (spec) => {
                forEachIdentifier(spec, "name", (text, ident) => push(out, "variable", text, ident));
            });
            return;
        }
        default:
            return;
    }
}

function forEachSpec(node: TreeSitterNode, specType: string, fn: (spec: TreeSitterNode) => void): void {
    for (let i = 0; i < node.namedChildCount; i += 1) {
        const child = node.namedChild(i);
        if (child && child.type === specType) fn(child);
    }
}

// Each spec has one or more "name" fields (Go allows `var a, b = 1, 2`).
// childForFieldName returns the first; we walk siblings looking for identifiers
// preceding the "=" or type annotation.
function forEachIdentifier(
    spec: TreeSitterNode,
    _field: string,
    fn: (text: string, node: TreeSitterNode) => void,
): void {
    for (let i = 0; i < spec.namedChildCount; i += 1) {
        const child = spec.namedChild(i);
        if (!child) continue;
        if (child.type === "identifier") fn(child.text, child);
        else break;
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
        if (child.type === "parameter_declaration" || child.type === "variadic_parameter_declaration") {
            const name = child.childForFieldName("name");
            if (name) {
                // Go allows `a, b int` — multiple name identifiers in one declaration.
                out.push(name.text);
                for (let j = 0; j < child.namedChildCount; j += 1) {
                    const sib = child.namedChild(j);
                    if (sib && sib.type === "identifier" && sib.text !== name.text) {
                        out.push(sib.text);
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

function push(out: MimeSymbol[], kind: SymbolKind, name: string, node: TreeSitterNode): void {
    out.push({
        name,
        kind,
        ...position(node),
    });
}

export { refsQuery } from "./queries/go.ts";
