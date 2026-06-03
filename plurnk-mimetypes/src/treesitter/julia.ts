import type { MimeSymbol, SymbolKind } from "../types.ts";
import type { TreeSitterNode } from "../TreeSitterExtractor.ts";

// Julia SPEC §3 mapping via tree-sitter-julia.
//
//   module_definition         → module (recurse)
//   struct_definition         → class (with type_head identifier)
//   mutable_struct_definition → class
//   abstract_definition       → class (abstract type)
//   primitive_definition      → class
//   function_definition       → function/method (signature → call_expression)
//   short_function_definition → function (one-liner: name(args) = expr)
//   macro_definition          → function
//   const_statement           → constant (assignment LHS identifier)
//   assignment (top-level)    → variable / constant (SCREAMING → constant)
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
        case "module_definition":
        case "bare_module_definition": {
            const name = childFieldText(node, "name") ?? firstIdentifierText(node);
            if (!name) return;
            push(out, "module", name, node);
            walk(node, out, true);
            return;
        }
        case "struct_definition":
        case "mutable_struct_definition":
        case "primitive_definition": {
            const head = findChildOfType(node, "type_head");
            const name = head ? firstIdentifierText(head) : firstIdentifierText(node);
            if (name) push(out, "class", name, node);
            return;
        }
        case "abstract_definition": {
            const head = findChildOfType(node, "type_head");
            const name = head ? firstIdentifierText(head) : firstIdentifierText(node);
            if (name) push(out, "class", name, node);
            return;
        }
        case "function_definition":
        case "short_function_definition": {
            const sig = findChildOfType(node, "signature");
            if (!sig) return;
            const call = findChildOfType(sig, "call_expression");
            if (!call) return;
            const name = firstIdentifierText(call);
            if (!name) return;
            const args = findChildOfType(call, "argument_list");
            const params: string[] = [];
            if (args) {
                for (let i = 0; i < args.namedChildCount; i += 1) {
                    const a = args.namedChild(i);
                    if (!a) continue;
                    if (a.type === "identifier") params.push(a.text);
                    else if (a.type === "typed_expression" || a.type === "keyword_parameter"
                        || a.type === "optional_parameter") {
                        const ident = firstIdentifierText(a);
                        if (ident) params.push(ident);
                    }
                }
            }
            out.push({
                name,
                kind: inModule ? "method" : "function",
                line: node.startPosition.row + 1,
                endLine: node.endPosition.row + 1,
                params,
            });
            return;
        }
        case "macro_definition": {
            const sig = findChildOfType(node, "signature");
            const call = sig ? findChildOfType(sig, "call_expression") : null;
            const name = call ? firstIdentifierText(call) : firstIdentifierText(node);
            if (name) push(out, "function", name, node);
            return;
        }
        case "const_statement": {
            // const x = ...; left side is the assignment target.
            const assign = findChildOfType(node, "assignment");
            const target = assign ? assign.namedChild(0) : null;
            if (target && target.type === "identifier") {
                push(out, "constant", target.text, node);
            }
            return;
        }
        case "assignment": {
            const target = node.namedChild(0);
            if (!target) return;
            // `f(x) = expr` parses as assignment with call_expression LHS —
            // this is Julia's short-form function syntax.
            if (target.type === "call_expression") {
                const fname = firstIdentifierText(target);
                if (!fname) return;
                const args = findChildOfType(target, "argument_list");
                const params: string[] = [];
                if (args) {
                    for (let i = 0; i < args.namedChildCount; i += 1) {
                        const a = args.namedChild(i);
                        if (!a) continue;
                        if (a.type === "identifier") params.push(a.text);
                        else {
                            const ident = firstIdentifierText(a);
                            if (ident) params.push(ident);
                        }
                    }
                }
                out.push({
                    name: fname,
                    kind: inModule ? "method" : "function",
                    line: node.startPosition.row + 1,
                    endLine: node.endPosition.row + 1,
                    params,
                });
                return;
            }
            if (target.type !== "identifier") return;
            const name = target.text;
            push(out, isScreamingSnake(name) ? "constant" : "variable", name, node);
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

function isScreamingSnake(name: string): boolean {
    if (name.length === 0) return false;
    let hasLetter = false;
    for (const c of name) {
        if (c >= "A" && c <= "Z") hasLetter = true;
        else if (c === "_" || (c >= "0" && c <= "9")) continue;
        else return false;
    }
    return hasLetter;
}

function push(out: MimeSymbol[], kind: SymbolKind, name: string, node: TreeSitterNode): void {
    out.push({
        name,
        kind,
        line: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
    });
}
