import type { MimeSymbol, SymbolKind } from "../types.ts";
import type { TreeSitterNode } from "../TreeSitterExtractor.ts";

// Lua SPEC §3 mapping via @tree-sitter-grammars/tree-sitter-lua.
//
//   function_declaration with name: identifier            → function
//   function_declaration with name: dot_index_expression  → method (M.foo on table M)
//   function_declaration with name: method_index_expression → method (Class:method)
//   local_declaration → variable_declaration → assignment → identifier:
//                                                          variable / constant
//
// Issue #18: flat mapping — no recursion into named scopes, so no containers;
// symbols carry 1-indexed columns only.
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
        case "function_declaration": {
            const nameNode = node.childForFieldName("name");
            if (!nameNode) return;
            const params = extractParams(node.childForFieldName("parameters"));
            const line = node.startPosition.row + 1;
            const endLine = node.endPosition.row + 1;
            const column = node.startPosition.column + 1;
            const endColumn = node.endPosition.column + 1;
            if (nameNode.type === "identifier") {
                out.push({ name: nameNode.text, kind: "function", line, endLine, column, endColumn, params });
            } else if (nameNode.type === "dot_index_expression") {
                const field = nameNode.childForFieldName("field");
                if (field) out.push({ name: field.text, kind: "method", line, endLine, column, endColumn, params });
            } else if (nameNode.type === "method_index_expression") {
                const method = nameNode.childForFieldName("method");
                if (method) out.push({ name: method.text, kind: "method", line, endLine, column, endColumn, params });
            }
            return;
        }
        case "local_declaration":
        case "variable_declaration": {
            // local_declaration wraps variable_declaration which wraps
            // assignment_statement.
            const inner = node.type === "local_declaration"
                ? findChildOfType(node, "variable_declaration")
                : node;
            if (!inner) return;
            const assign = findChildOfType(inner, "assignment_statement") ?? inner;
            const varList = findChildOfType(assign, "variable_list");
            if (!varList) return;
            for (let i = 0; i < varList.namedChildCount; i += 1) {
                const v = varList.namedChild(i);
                if (!v) continue;
                if (v.type === "identifier") {
                    push(out, isScreamingSnake(v.text) ? "constant" : "variable", v.text, node);
                }
            }
            return;
        }
        case "assignment_statement": {
            // Top-level non-local assignment: globals.
            const varList = findChildOfType(node, "variable_list");
            if (!varList) return;
            for (let i = 0; i < varList.namedChildCount; i += 1) {
                const v = varList.namedChild(i);
                if (!v) continue;
                if (v.type === "identifier") {
                    push(out, isScreamingSnake(v.text) ? "constant" : "variable", v.text, node);
                }
            }
            return;
        }
        default:
            return;
    }
}

function findChildOfType(node: TreeSitterNode, type: string): TreeSitterNode | null {
    for (let i = 0; i < node.namedChildCount; i += 1) {
        const child = node.namedChild(i);
        if (child && child.type === type) return child;
    }
    return null;
}

function extractParams(parametersNode: TreeSitterNode | null): string[] {
    if (!parametersNode) return [];
    const out: string[] = [];
    for (let i = 0; i < parametersNode.namedChildCount; i += 1) {
        const child = parametersNode.namedChild(i);
        if (!child) continue;
        if (child.type === "identifier") out.push(child.text);
    }
    return out;
}

function isScreamingSnake(name: string): boolean {
    // Lua module convention: `local M = {}` — single uppercase letters are
    // module table variables, not constants. Require at least 2 chars to
    // qualify as SCREAMING.
    if (name.length < 2) return false;
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
        column: node.startPosition.column + 1,
        endColumn: node.endPosition.column + 1,
    });
}
