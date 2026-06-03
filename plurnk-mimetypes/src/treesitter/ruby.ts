import type { MimeSymbol, SymbolKind } from "../types.ts";
import type { TreeSitterNode } from "../TreeSitterExtractor.ts";

// Ruby SPEC §3 mapping via tree-sitter-ruby.
//
//   module                              → module; recurse into body
//   class                               → class; recurse into body with inClass=true
//   method                              → method (in class) or function (top-level)
//   singleton_method (def self.foo)     → method (rendered with prefix)
//   assignment of constant (UPPER_CASE) → constant
//   call → attr_accessor / attr_reader  → field
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
        case "module": {
            const name = firstNamedOfTypes(node, ["constant", "scope_resolution"]);
            if (name) push(out, "module", name.text, node);
            const body = firstNamedOfTypes(node, ["body_statement"]);
            if (body) walk(body, out, false);
            return;
        }
        case "class": {
            const name = firstNamedOfTypes(node, ["constant", "scope_resolution"]);
            if (name) push(out, "class", name.text, node);
            const body = firstNamedOfTypes(node, ["body_statement"]);
            if (body) walk(body, out, true);
            return;
        }
        case "method": {
            const id = firstNamedOfTypes(node, ["identifier", "constant", "operator"]);
            if (!id) return;
            const params = extractRubyParams(firstNamedOfTypes(node, ["method_parameters"]));
            push(out, inClass ? "method" : "function", id.text, node, params);
            return;
        }
        case "singleton_method": {
            const id = firstNamedOfTypes(node, ["identifier", "constant"]);
            if (!id) return;
            const params = extractRubyParams(firstNamedOfTypes(node, ["method_parameters"]));
            push(out, "method", id.text, node, params);
            return;
        }
        case "assignment": {
            const left = firstNamedOfTypes(node, ["constant"]);
            if (!left) return;
            push(out, "constant", left.text, node);
            return;
        }
        case "call": {
            // attr_accessor / attr_reader / attr_writer :name [, :name2 ...]
            const recv = firstNamedOfTypes(node, ["identifier"]);
            if (!recv) return;
            const t = recv.text;
            if (t !== "attr_accessor" && t !== "attr_reader" && t !== "attr_writer") return;
            const args = firstNamedOfTypes(node, ["argument_list"]);
            if (!args) return;
            for (let i = 0; i < args.namedChildCount; i += 1) {
                const arg = args.namedChild(i);
                if (!arg) continue;
                if (arg.type === "simple_symbol") {
                    const name = arg.text.startsWith(":") ? arg.text.slice(1) : arg.text;
                    push(out, "field", name, arg);
                }
            }
            return;
        }
        default:
            return;
    }
}

function firstNamedOfTypes(node: TreeSitterNode, types: string[]): TreeSitterNode | null {
    const wanted = new Set(types);
    for (let i = 0; i < node.namedChildCount; i += 1) {
        const child = node.namedChild(i);
        if (child && wanted.has(child.type)) return child;
    }
    return null;
}

function extractRubyParams(node: TreeSitterNode | null): string[] {
    if (!node) return [];
    const out: string[] = [];
    for (let i = 0; i < node.namedChildCount; i += 1) {
        const p = node.namedChild(i);
        if (!p) continue;
        if (p.type === "identifier") {
            out.push(p.text);
        } else if (p.type === "optional_parameter" || p.type === "keyword_parameter") {
            const id = firstNamedOfTypes(p, ["identifier"]);
            if (id) out.push(id.text);
        }
    }
    return out;
}

function push(
    out: MimeSymbol[],
    kind: SymbolKind,
    name: string,
    node: TreeSitterNode,
    params?: string[],
): void {
    const sym: MimeSymbol = {
        name,
        kind,
        line: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
    };
    if (params !== undefined) sym.params = params;
    out.push(sym);
}
