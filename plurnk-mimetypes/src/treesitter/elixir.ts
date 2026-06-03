import type { MimeSymbol, SymbolKind } from "../types.ts";
import type { TreeSitterNode } from "../TreeSitterExtractor.ts";

// Elixir SPEC §3 mapping via tree-sitter-elixir.
//
// Elixir's uniform syntax means everything is a `call` node whose `target`
// identifier names the macro (def, defp, defmodule, defprotocol, etc). We
// dispatch by target text. Patterns mirror tree-sitter-elixir's tags.scm
// for definitions.
//
//   call defmodule/defprotocol  → module (recurse into do_block)
//   call def/defp/defmacro/...  → function (no body recursion)
const MODULE_MACROS = new Set(["defmodule", "defprotocol", "defimpl"]);
const FUNCTION_MACROS = new Set([
    "def", "defp", "defdelegate", "defguard", "defguardp",
    "defmacro", "defmacrop", "defn", "defnp",
]);

export function extract(root: TreeSitterNode, _content: string): MimeSymbol[] {
    const out: MimeSymbol[] = [];
    walk(root, out);
    return out;
}

function walk(node: TreeSitterNode, out: MimeSymbol[]): void {
    for (let i = 0; i < node.namedChildCount; i += 1) {
        const child = node.namedChild(i);
        if (!child) continue;
        if (child.type === "call") {
            handleCall(child, out);
            continue;
        }
        walk(child, out);
    }
}

function handleCall(call: TreeSitterNode, out: MimeSymbol[]): void {
    const target = call.childForFieldName("target");
    if (!target || target.type !== "identifier") {
        walk(call, out);
        return;
    }
    const macro = target.text;
    if (MODULE_MACROS.has(macro)) {
        const name = extractModuleName(call);
        if (name) push(out, "module", name, call);
        // Recurse into the do_block to find inner def/defp/nested modules.
        const doBlock = findDoBlock(call);
        if (doBlock) walk(doBlock, out);
        return;
    }
    if (FUNCTION_MACROS.has(macro)) {
        const fnInfo = extractFunctionName(call);
        if (fnInfo) {
            out.push({
                name: fnInfo.name,
                kind: "function" as SymbolKind,
                line: call.startPosition.row + 1,
                endLine: call.endPosition.row + 1,
                params: fnInfo.params,
            });
        }
        return;
    }
    // Other macros (use, import, alias, etc.) — recurse into args to surface
    // nested defs (e.g. inside `quote do ... def foo ... end`).
    walk(call, out);
}

function extractModuleName(call: TreeSitterNode): string | null {
    const args = findArguments(call);
    if (!args) return null;
    for (let i = 0; i < args.namedChildCount; i += 1) {
        const child = args.namedChild(i);
        if (child && child.type === "alias") return child.text;
    }
    return null;
}

function extractFunctionName(call: TreeSitterNode): { name: string; params: string[] } | null {
    const args = findArguments(call);
    if (!args) return null;
    for (let i = 0; i < args.namedChildCount; i += 1) {
        const child = args.namedChild(i);
        if (!child) continue;
        // zero-arity function: arguments → identifier
        if (child.type === "identifier") return { name: child.text, params: [] };
        // regular function: arguments → call(target: identifier, arguments: ...)
        if (child.type === "call") {
            const inner = child.childForFieldName("target");
            if (inner && inner.type === "identifier") {
                return { name: inner.text, params: extractParams(findArguments(child)) };
            }
        }
        // guarded function: arguments → binary_operator(left: call(target: identifier), operator: when)
        if (child.type === "binary_operator") {
            const op = child.childForFieldName("operator");
            const left = child.childForFieldName("left");
            if (op && op.text === "when" && left && left.type === "call") {
                const inner = left.childForFieldName("target");
                if (inner && inner.type === "identifier") {
                    return { name: inner.text, params: extractParams(findArguments(left)) };
                }
            }
        }
    }
    return null;
}

function extractParams(argsNode: TreeSitterNode | null): string[] {
    if (!argsNode) return [];
    const out: string[] = [];
    for (let i = 0; i < argsNode.namedChildCount; i += 1) {
        const child = argsNode.namedChild(i);
        if (!child) continue;
        if (child.type === "identifier") out.push(child.text);
        else if (child.type === "binary_operator") {
            // default value: `x \\ 0` — left identifier is the param name.
            const left = child.childForFieldName("left");
            if (left && left.type === "identifier") out.push(left.text);
        } else if (child.type === "tuple" || child.type === "map" || child.type === "list") {
            // destructured pattern — surface the source text as the param descriptor.
            out.push(child.text);
        } else {
            // Any other pattern node — fall back to its text.
            out.push(child.text);
        }
    }
    return out;
}

function findArguments(call: TreeSitterNode): TreeSitterNode | null {
    for (let i = 0; i < call.namedChildCount; i += 1) {
        const child = call.namedChild(i);
        if (child && child.type === "arguments") return child;
    }
    return null;
}

function findDoBlock(call: TreeSitterNode): TreeSitterNode | null {
    // do_block may appear as a direct child of `call` or nested inside arguments.
    for (let i = 0; i < call.namedChildCount; i += 1) {
        const child = call.namedChild(i);
        if (!child) continue;
        if (child.type === "do_block") return child;
        if (child.type === "arguments") {
            for (let j = 0; j < child.namedChildCount; j += 1) {
                const sub = child.namedChild(j);
                if (sub && sub.type === "do_block") return sub;
            }
        }
    }
    return null;
}

function push(out: MimeSymbol[], kind: SymbolKind, name: string, node: TreeSitterNode): void {
    out.push({
        name,
        kind,
        line: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
    });
}
