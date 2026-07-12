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
//      anon_type_defn (implicit constructor) /
//      object_type_defn / class_type_defn       → class
//      delegate_type_defn / type_abbrev_defn    → type
//   member_defn                                 → method (member val → field)
//   type_extension_elements /
//   interface_implementation                    → unwrap recursively
//   module_defn                                 → unwrap recursively
//
// Container semantics (issue #18): declarations inside a named module or
// namespace carry its name; record fields, union cases, and members carry
// the owning type appended to that path.
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
        case "named_module":
        case "namespace": {
            const name = moduleNameText(node);
            if (name) push(out, "module", name, node, container);
            walk(node, out, name ? appendPath(container, name) : container);
            return;
        }
        case "value_declaration": {
            for (let i = 0; i < node.namedChildCount; i += 1) {
                const child = node.namedChild(i);
                if (!child) continue;
                if (child.type === "function_or_value_defn") {
                    handleFnOrValue(child, out, container);
                }
            }
            return;
        }
        case "type_definition": {
            for (let i = 0; i < node.namedChildCount; i += 1) {
                const child = node.namedChild(i);
                if (!child) continue;
                handleTypeDefnVariant(child, out, container);
            }
            return;
        }
        case "module_defn": {
            // Inline module — walk its body recursively. The mapping does not
            // emit inline modules as symbols, so the container is unchanged.
            walk(node, out, container);
            return;
        }
        case "member_defn": {
            handleMemberDefn(node, out, container);
            return;
        }
        case "type_extension_elements":
        case "interface_implementation": {
            // Member groups inside a type body — walk so member_defn and
            // let-bound function_or_value_defn children dispatch with the
            // owning type's container.
            walk(node, out, container);
            return;
        }
        case "function_or_value_defn": {
            // Bare let binding inside a type body (no value_declaration wrapper).
            handleFnOrValue(node, out, container);
            return;
        }
        default:
            return;
    }
}

function handleFnOrValue(node: TreeSitterNode, out: MimeSymbol[], container: string): void {
    const fnLeft = findChildOfType(node, "function_declaration_left");
    if (fnLeft) {
        const name = firstIdentifierText(fnLeft);
        if (name) {
            out.push({
                name,
                kind: "function",
                ...position(node),
                ...(container.length > 0 && { container }),
                params: extractArgPatterns(findChildOfType(fnLeft, "argument_patterns")),
            });
        }
        return;
    }
    const valLeft = findChildOfType(node, "value_declaration_left");
    if (valLeft) {
        const name = deepFirstIdentifier(valLeft);
        if (name) push(out, "constant", name, node, container);
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

// member_defn shapes: function_declaration_left (extension members),
// method_or_prop_defn (implicit-constructor type bodies, `member this.Run x`),
// member_signature (abstract members), bare property_or_ident (`member val`).
function handleMemberDefn(node: TreeSitterNode, out: MimeSymbol[], container: string): void {
    const left = findChildOfType(node, "function_declaration_left");
    if (left) {
        const name = firstIdentifierText(left);
        if (name) {
            out.push({
                name,
                kind: "method",
                ...position(node),
                ...(container.length > 0 && { container }),
                params: extractArgPatterns(findChildOfType(left, "argument_patterns")),
            });
        }
        return;
    }
    const method = findChildOfType(node, "method_or_prop_defn");
    if (method) {
        const name = memberName(findChildOfType(method, "property_or_ident"));
        if (name) {
            out.push({
                name,
                kind: "method",
                ...position(node),
                ...(container.length > 0 && { container }),
                params: methodParams(method),
            });
        }
        return;
    }
    const signature = findChildOfType(node, "member_signature");
    if (signature) {
        const name = firstIdentifierText(signature);
        if (name) push(out, "method", name, node, container);
        return;
    }
    const prop = findChildOfType(node, "property_or_ident");
    if (prop) {
        const name = memberName(prop);
        if (name) push(out, "field", name, node, container);
    }
}

// property_or_ident is `self.Name` or bare `Name` — the member name is the
// last identifier child.
function memberName(node: TreeSitterNode | null): string | null {
    if (!node) return null;
    let name: string | null = null;
    for (let i = 0; i < node.namedChildCount; i += 1) {
        const child = node.namedChild(i);
        if (child && child.type === "identifier") name = child.text;
    }
    return name;
}

// method_or_prop_defn children: property_or_ident, then argument patterns,
// then the body expression(s) — patterns run until the first non-pattern.
// A unit pattern parses as const and yields no identifier.
function methodParams(node: TreeSitterNode): string[] {
    const out: string[] = [];
    for (let i = 1; i < node.namedChildCount; i += 1) {
        const child = node.namedChild(i);
        if (!child) continue;
        if (!child.type.endsWith("_pattern") && child.type !== "const") break;
        const name = deepFirstIdentifier(child);
        if (name) out.push(name);
    }
    return out;
}

function handleTypeDefnVariant(node: TreeSitterNode, out: MimeSymbol[], container: string): void {
    switch (node.type) {
        case "record_type_defn": {
            const name = typeName(node);
            if (name) push(out, "class", name, node, container);
            const block = findChildOfType(node, "record_fields");
            if (block) {
                const fieldContainer = name ? appendPath(container, name) : container;
                for (let i = 0; i < block.namedChildCount; i += 1) {
                    const f = block.namedChild(i);
                    if (f && f.type === "record_field") {
                        const fname = firstIdentifierText(f);
                        if (fname) push(out, "field", fname, f, fieldContainer);
                    }
                }
            }
            return;
        }
        case "union_type_defn": {
            const name = typeName(node);
            if (name) push(out, "enum", name, node, container);
            const cases = findChildOfType(node, "union_type_cases");
            if (cases) {
                const caseContainer = name ? appendPath(container, name) : container;
                for (let i = 0; i < cases.namedChildCount; i += 1) {
                    const c = cases.namedChild(i);
                    if (c && c.type === "union_type_case") {
                        const cname = firstIdentifierText(c);
                        if (cname) push(out, "constant", cname, c, caseContainer);
                    }
                }
            }
            return;
        }
        case "anon_type_defn":
        case "object_type_defn":
        case "class_type_defn": {
            const name = typeName(node);
            if (name) push(out, "class", name, node, container);
            // members are member_defn nodes inside the type body — walk descend.
            walk(node, out, name ? appendPath(container, name) : container);
            return;
        }
        case "delegate_type_defn":
        case "type_abbrev_defn": {
            const name = typeName(node);
            if (name) push(out, "type", name, node, container);
            return;
        }
        case "enum_type_defn": {
            const name = typeName(node);
            if (name) push(out, "enum", name, node, container);
            return;
        }
        default:
            return;
    }
}

function appendPath(container: string, name: string): string {
    return container.length > 0 ? `${container}.${name}` : name;
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

function position(node: TreeSitterNode): Pick<MimeSymbol, "line" | "endLine" | "column" | "endColumn"> {
    return {
        line: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        column: node.startPosition.column + 1,
        endColumn: node.endPosition.column + 1,
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

export { refsQuery } from "./queries/fsharp.ts";
