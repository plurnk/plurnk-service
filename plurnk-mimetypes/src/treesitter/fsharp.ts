import type { MimeSymbol, SymbolKind } from "../types.ts";
import type { TreeSitterNode } from "../TreeSitterExtractor.ts";

// F# SPEC §3 mapping via tree-sitter-fsharp.
//
//   named_module / namespace                    → module (recurse)
//   value_declaration → function_or_value_defn:
//      function_declaration_left (with args)    → function
//      value_declaration_left (no args)         → constant
//   type_definition:
//      record_type_defn                         → class + record_field → field
//      union_type_defn                          → enum + union_type_case → constant
//      object_type_defn / class_type_defn       → class
//      delegate_type_defn / type_abbrev_defn    → type
//   member_defn                                 → method
//   module_defn                                 → unwrap recursively
export function extract(root: TreeSitterNode, _content: string): MimeSymbol[] {
    const out: MimeSymbol[] = [];
    walk(root, out, /*inModule*/ false);
    return out;
}

function walk(node: TreeSitterNode, out: MimeSymbol[], inModule: boolean): void {
    for (let i = 0; i < node.namedChildCount; i += 1) {
        const child = node.namedChild(i);
        if (!child) continue;
        dispatch(child, out, inModule);
    }
}

function dispatch(node: TreeSitterNode, out: MimeSymbol[], inModule: boolean): void {
    switch (node.type) {
        case "named_module":
        case "namespace": {
            const name = moduleNameText(node);
            if (name) push(out, "module", name, node);
            walk(node, out, true);
            return;
        }
        case "value_declaration": {
            for (let i = 0; i < node.namedChildCount; i += 1) {
                const child = node.namedChild(i);
                if (!child) continue;
                if (child.type === "function_or_value_defn") {
                    handleFnOrValue(child, out, inModule);
                }
            }
            return;
        }
        case "type_definition": {
            for (let i = 0; i < node.namedChildCount; i += 1) {
                const child = node.namedChild(i);
                if (!child) continue;
                handleTypeDefnVariant(child, out);
            }
            return;
        }
        case "module_defn": {
            // Inline module — walk its body recursively.
            walk(node, out, true);
            return;
        }
        case "member_defn": {
            // Method inside a type. Find the function_declaration_left identifier.
            const left = findChildOfType(node, "function_declaration_left");
            if (left) {
                const name = firstIdentifierText(left);
                if (name) {
                    out.push({
                        name,
                        kind: "method",
                        line: node.startPosition.row + 1,
                        endLine: node.endPosition.row + 1,
                        params: extractArgPatterns(findChildOfType(left, "argument_patterns")),
                    });
                }
            }
            return;
        }
        default:
            return;
    }
}

function handleFnOrValue(node: TreeSitterNode, out: MimeSymbol[], inModule: boolean): void {
    const fnLeft = findChildOfType(node, "function_declaration_left");
    if (fnLeft) {
        const name = firstIdentifierText(fnLeft);
        if (name) {
            out.push({
                name,
                kind: inModule ? "function" : "function",
                line: node.startPosition.row + 1,
                endLine: node.endPosition.row + 1,
                params: extractArgPatterns(findChildOfType(fnLeft, "argument_patterns")),
            });
        }
        return;
    }
    const valLeft = findChildOfType(node, "value_declaration_left");
    if (valLeft) {
        const name = deepFirstIdentifier(valLeft);
        if (name) push(out, "constant", name, node);
    }
}

// Drill through identifier_pattern / long_identifier_or_op wrappers to the
// underlying identifier.
function deepFirstIdentifier(node: TreeSitterNode): string | null {
    const stack: TreeSitterNode[] = [node];
    while (stack.length > 0) {
        const cur = stack.pop()!;
        if (cur.type === "identifier") return cur.text;
        if (cur.type === "long_identifier") return cur.text;
        for (let i = cur.namedChildCount - 1; i >= 0; i -= 1) {
            const child = cur.namedChild(i);
            if (child) stack.push(child);
        }
    }
    return null;
}

function handleTypeDefnVariant(node: TreeSitterNode, out: MimeSymbol[]): void {
    switch (node.type) {
        case "record_type_defn": {
            const name = typeName(node);
            if (name) push(out, "class", name, node);
            const block = findChildOfType(node, "record_fields");
            if (block) {
                for (let i = 0; i < block.namedChildCount; i += 1) {
                    const f = block.namedChild(i);
                    if (f && f.type === "record_field") {
                        const fname = firstIdentifierText(f);
                        if (fname) push(out, "field", fname, f);
                    }
                }
            }
            return;
        }
        case "union_type_defn": {
            const name = typeName(node);
            if (name) push(out, "enum", name, node);
            const cases = findChildOfType(node, "union_type_cases");
            if (cases) {
                for (let i = 0; i < cases.namedChildCount; i += 1) {
                    const c = cases.namedChild(i);
                    if (c && c.type === "union_type_case") {
                        const cname = firstIdentifierText(c);
                        if (cname) push(out, "constant", cname, c);
                    }
                }
            }
            return;
        }
        case "object_type_defn":
        case "class_type_defn": {
            const name = typeName(node);
            if (name) push(out, "class", name, node);
            // members are member_defn nodes inside the type body — walk descend.
            walk(node, out, true);
            return;
        }
        case "delegate_type_defn":
        case "type_abbrev_defn": {
            const name = typeName(node);
            if (name) push(out, "type", name, node);
            return;
        }
        case "enum_type_defn": {
            const name = typeName(node);
            if (name) push(out, "enum", name, node);
            return;
        }
        default:
            return;
    }
}

function typeName(node: TreeSitterNode): string | null {
    const tn = findChildOfType(node, "type_name");
    if (!tn) return null;
    return childFieldText(tn, "type_name") ?? firstIdentifierText(tn);
}

function moduleNameText(node: TreeSitterNode): string | null {
    const name = node.childForFieldName("name");
    if (!name) return null;
    if (name.type === "long_identifier") return name.text;
    return name.text;
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
        if (child.type === "long_identifier") return child.text;
    }
    return null;
}

function extractArgPatterns(argsNode: TreeSitterNode | null): string[] {
    if (!argsNode) return [];
    const out: string[] = [];
    for (let i = 0; i < argsNode.namedChildCount; i += 1) {
        const child = argsNode.namedChild(i);
        if (!child) continue;
        // argument_patterns children are long_identifier (single name) or
        // pattern wrappers (parenthesized/typed).
        if (child.type === "long_identifier") {
            out.push(child.text);
        } else {
            const ident = firstIdentifierText(child);
            if (ident) out.push(ident);
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
