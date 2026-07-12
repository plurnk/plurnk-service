import type { MimeSymbol, SymbolKind } from "../types.ts";
import type { TreeSitterNode } from "../TreeSitterExtractor.ts";

// Ruby SPEC §3 mapping via tree-sitter-ruby.
//
//   module                              → module; recurse into body
//   class                               → class; recurse into body
//   method                              → method (in module/class) or function (top-level)
//   singleton_method (def self.foo)     → method (rendered with prefix)
//   assignment of constant (UPPER_CASE) → constant
//   call → attr_accessor / attr_reader  → field
//
// Container semantics (issue #18): symbols inside a module/class carry the
// dotted path of enclosing emitted names. Top-level symbols carry none.
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
        case "module": {
            const name = firstNamedOfTypes(node, ["constant", "scope_resolution"]);
            if (name) push(out, "module", name.text, node, container);
            const body = firstNamedOfTypes(node, ["body_statement"]);
            const inner = name
                ? (container.length > 0 ? `${container}.${name.text}` : name.text)
                : container;
            if (body) walk(body, out, inner);
            return;
        }
        case "class": {
            const name = firstNamedOfTypes(node, ["constant", "scope_resolution"]);
            if (name) push(out, "class", name.text, node, container);
            const body = firstNamedOfTypes(node, ["body_statement"]);
            const inner = name
                ? (container.length > 0 ? `${container}.${name.text}` : name.text)
                : container;
            if (body) walk(body, out, inner);
            return;
        }
        case "method": {
            const id = firstNamedOfTypes(node, ["identifier", "constant", "operator"]);
            if (!id) return;
            const params = extractRubyParams(firstNamedOfTypes(node, ["method_parameters"]));
            push(out, container.length > 0 ? "method" : "function", id.text, node, container, params);
            return;
        }
        case "singleton_method": {
            const id = firstNamedOfTypes(node, ["identifier", "constant"]);
            if (!id) return;
            const params = extractRubyParams(firstNamedOfTypes(node, ["method_parameters"]));
            push(out, "method", id.text, node, container, params);
            return;
        }
        case "assignment": {
            const left = firstNamedOfTypes(node, ["constant"]);
            if (!left) return;
            push(out, "constant", left.text, node, container);
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
                    push(out, "field", name, arg, container);
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
    container: string,
    params?: string[],
): void {
    const sym: MimeSymbol = {
        name,
        kind,
        line: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        column: node.startPosition.column + 1,
        endColumn: node.endPosition.column + 1,
    };
    if (container.length > 0) sym.container = container;
    if (params !== undefined) sym.params = params;
    out.push(sym);
}

export { refsQuery } from "./queries/ruby.ts";
