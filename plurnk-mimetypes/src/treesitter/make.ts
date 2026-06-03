import type { MimeSymbol, SymbolKind } from "../types.ts";
import type { TreeSitterNode } from "../TreeSitterExtractor.ts";

// Makefile SPEC §3 mapping via tree-sitter-make.
//
//   variable_assignment  → variable (or constant if SCREAMING_SNAKE)
//   rule.targets         → function per word (targets are entry points)
//   define_directive     → function (multi-line variable as macro)
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
        case "variable_assignment": {
            const name = childFieldText(node, "name");
            if (!name) return;
            push(out, isScreamingSnake(name) ? "constant" : "variable", name, node);
            return;
        }
        case "rule": {
            const targets = findChildOfType(node, "targets");
            if (!targets) return;
            for (let i = 0; i < targets.namedChildCount; i += 1) {
                const t = targets.namedChild(i);
                if (!t) continue;
                if (t.type === "word") push(out, "function", t.text, node);
            }
            return;
        }
        case "define_directive": {
            const name = childFieldText(node, "name");
            if (name) push(out, "function", name, node);
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
