import type { MimeSymbol } from "./types.ts";

export interface TreeNode {
    symbol: MimeSymbol;
    children: TreeNode[];
}

export function buildTree(symbols: MimeSymbol[]): TreeNode[] {
    const sorted = [...symbols].sort((a, b) => {
        if (a.line !== b.line) return a.line - b.line;
        return b.endLine - a.endLine;
    });

    const roots: TreeNode[] = [];
    const stack: TreeNode[] = [];

    for (const symbol of sorted) {
        if (symbol.kind === "heading" && symbol.level !== undefined) {
            const level = symbol.level;
            while (stack.length > 0) {
                const top = stack[stack.length - 1].symbol;
                if (top.kind === "heading" && top.level !== undefined && top.level < level) break;
                stack.pop();
            }
        } else {
            while (stack.length > 0) {
                const top = stack[stack.length - 1].symbol;
                if (top.line <= symbol.line && top.endLine >= symbol.endLine) break;
                stack.pop();
            }
        }

        const node: TreeNode = { symbol, children: [] };
        if (stack.length === 0) roots.push(node);
        else stack[stack.length - 1].children.push(node);
        stack.push(node);
    }

    return roots;
}

export function maxDepth(nodes: TreeNode[]): number {
    let max = 0;
    const walk = (ns: TreeNode[], depth: number): void => {
        if (ns.length === 0) return;
        if (depth > max) max = depth;
        for (const node of ns) walk(node.children, depth + 1);
    };
    walk(nodes, 0);
    return max;
}

export function pruneToMaxDepth(nodes: TreeNode[], limit: number): TreeNode[] {
    if (limit < 0) return [];
    return nodes.map((node) => ({
        symbol: node.symbol,
        children: limit === 0 ? [] : pruneToMaxDepth(node.children, limit - 1),
    }));
}

export function renderTree(nodes: TreeNode[]): string {
    const lines: string[] = [];
    const walk = (ns: TreeNode[], depth: number): void => {
        for (const node of ns) {
            lines.push(renderLine(node.symbol, depth));
            walk(node.children, depth + 1);
        }
    };
    walk(nodes, 0);
    return lines.join("\n");
}

export function format(symbols: MimeSymbol[]): string {
    if (symbols.length === 0) return "";
    return renderTree(buildTree(symbols));
}

function renderLine(symbol: MimeSymbol, depth: number): string {
    const indent = "  ".repeat(depth);

    if (symbol.kind === "heading" && symbol.level !== undefined) {
        const hash = "#".repeat(symbol.level);
        return `${indent}${hash} ${symbol.name} [${symbol.line}]`;
    }

    const params = symbol.params !== undefined ? `(${symbol.params.join(", ")})` : "";
    const range = symbol.line === symbol.endLine
        ? `[${symbol.line}]`
        : `[${symbol.line}-${symbol.endLine}]`;
    return `${indent}${symbol.kind} ${symbol.name}${params} ${range}`;
}
