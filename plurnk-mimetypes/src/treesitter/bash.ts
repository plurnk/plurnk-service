import type { MimeSymbol } from "../types.ts";
import type { TreeSitterNode } from "../TreeSitterExtractor.ts";

// Bash SPEC §3 mapping via tree-sitter-bash.
//
//   function_definition          → function
//   variable_assignment          → variable (or constant if `readonly`)
//   declaration_command          → variable/constant (readonly | local | declare | export)
export function extract(root: TreeSitterNode, _content: string): MimeSymbol[] {
    const out: MimeSymbol[] = [];
    for (let i = 0; i < root.namedChildCount; i += 1) {
        const node = root.namedChild(i);
        if (!node) continue;
        dispatch(node, out, /*forceConstant*/ false);
    }
    return out;
}

function dispatch(node: TreeSitterNode, out: MimeSymbol[], forceConstant: boolean): void {
    switch (node.type) {
        case "function_definition": {
            // first named child is the function name (a `word`)
            const name = firstNamedChild(node);
            if (name) push(out, "function", name.text, node);
            return;
        }
        case "variable_assignment": {
            const name = firstNamedChild(node);
            if (name) push(out, forceConstant ? "constant" : "variable", name.text, node);
            return;
        }
        case "declaration_command": {
            // declaration_command: readonly/local/declare/export VAR=VAL
            // The first child (raw, not named) is the keyword token. We don't
            // get it via namedChild — peek at the node text instead.
            const text = node.text;
            const isReadonly = /^\s*readonly\b/.test(text);
            for (let i = 0; i < node.namedChildCount; i += 1) {
                const child = node.namedChild(i);
                if (!child) continue;
                if (child.type === "variable_assignment") {
                    dispatch(child, out, isReadonly);
                }
            }
            return;
        }
        default:
            return;
    }
}

function firstNamedChild(node: TreeSitterNode): TreeSitterNode | null {
    return node.namedChildCount > 0 ? node.namedChild(0) : null;
}

function push(
    out: MimeSymbol[],
    kind: "function" | "variable" | "constant",
    name: string,
    node: TreeSitterNode,
): void {
    out.push({
        name,
        kind,
        line: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        column: node.startPosition.column + 1,
        endColumn: node.endPosition.column + 1,
    });
}

export { refsQuery } from "./queries/bash.ts";
