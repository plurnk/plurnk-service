import { BaseHandler } from "@plurnk/plurnk-mimetypes";
import type { HandlerContent, MimeSymbol, Preview } from "@plurnk/plurnk-mimetypes";
import { Lexer, type Token } from "marked";

// text/markdown handler. Replaces the legacy regex heading scanner with
// marked's lexer — handles ATX headings, setext headings (=== / ---), leading
// whitespace edge cases, and gives us code-fence positions for free.
//
// Symbols emitted:
//   - heading: every heading at every depth, with `level` from token.depth
//   - module:  every fenced code block, named by its language tag (or "code"
//              when no language), with line range covering the full fence
//
// Hybrid preview: returns SymbolPreview when extractRaw finds structural
// signals (headings or code blocks), TextPreview head-oriented over the raw
// markdown body when it doesn't. The fallback handles the "poem case" —
// markdown content with no headings flat-renders rather than going dark.
//
// validate() inherits BaseHandler's no-op default (any string is valid markdown).
export default class TextMarkdown extends BaseHandler {
    override extractRaw(content: string): MimeSymbol[] {
        const tokens = new Lexer().lex(content);
        const symbols: MimeSymbol[] = [];
        let currentLine = 1;

        for (const token of tokens) {
            const raw = token.raw ?? "";
            const startLine = currentLine;
            const linesSpanned = countLinesSpanned(raw);
            const endLine = linesSpanned > 0 ? startLine + linesSpanned - 1 : startLine;

            emitFor(token, startLine, endLine, symbols);

            // Advance the line cursor by one for each \n in raw — each newline
            // moves us off its line onto the next.
            currentLine += countNewlines(raw);
        }

        return symbols;
    }

    override preview(content: string | Uint8Array): Preview {
        const text = typeof content === "string"
            ? content
            : new TextDecoder("utf-8").decode(content);
        const symbols = this.extractRaw(text);
        if (symbols.length > 0) {
            return { kind: "symbols", symbols };
        }
        return { kind: "text", text, orientation: "head" };
    }

    // Deep-channel (issue #10). The markdown AST as nested objects — heading,
    // paragraph, list, code block, blockquote, etc. — preserves enough
    // structure for jsonpath like `$..code[?(@.lang=='ts')]` or
    // `$..heading[?(@.depth==1)]`. Each node carries `type`, `line`, `endLine`,
    // plus its native marked fields (depth/text/lang/items/etc.).
    //
    // Returned as `{ type: "document", children: [...] }` so it presents as a
    // single rooted tree (matches the deep-xml projection: <document>...</document>).
    override deepJson(content: HandlerContent): unknown {
        if (typeof content !== "string") return null;
        let tokens: Token[];
        try {
            tokens = new Lexer().lex(content);
        } catch {
            return null;
        }
        const children: unknown[] = [];
        let currentLine = 1;
        for (const token of tokens) {
            const raw = token.raw ?? "";
            const startLine = currentLine;
            const linesSpanned = countLinesSpanned(raw);
            const endLine = linesSpanned > 0 ? startLine + linesSpanned - 1 : startLine;
            children.push(tokenToDeep(token, startLine, endLine));
            currentLine += countNewlines(raw);
        }
        return { type: "document", line: 1, endLine: currentLine, children };
    }
}

// Convert one marked token into a deep-tree node. Pulls the fields jsonpath
// users actually want to query (type, depth, text, lang, items) into named
// properties; drops parser-internal cursors that aren't queryable.
function tokenToDeep(token: Token, line: number, endLine: number): Record<string, unknown> {
    const t = token as Token & {
        depth?: number;
        text?: string;
        lang?: string;
        items?: Token[];
        tokens?: Token[];
        ordered?: boolean;
        href?: string;
        title?: string;
    };
    const node: Record<string, unknown> = { type: t.type, line, endLine };
    if (typeof t.depth === "number") node.level = t.depth;
    if (typeof t.text === "string" && t.text.length > 0) node.text = t.text;
    if (typeof t.lang === "string" && t.lang.length > 0) node.lang = t.lang;
    if (typeof t.href === "string") node.href = t.href;
    if (typeof t.title === "string") node.title = t.title;
    if (typeof t.ordered === "boolean") node.ordered = t.ordered;

    // Recurse into nested token trees (list items, paragraph inlines).
    // We don't track precise inner line ranges — parent's range covers them.
    const innerSource = t.items ?? t.tokens;
    if (Array.isArray(innerSource) && innerSource.length > 0) {
        node.children = innerSource.map((child) => tokenToDeep(child, line, endLine));
    }
    return node;
}

function emitFor(
    token: Token,
    startLine: number,
    endLine: number,
    into: MimeSymbol[],
): void {
    if (token.type === "heading") {
        const headingToken = token as Token & { depth: number; text: string };
        into.push({
            name: headingToken.text,
            kind: "heading",
            level: headingToken.depth,
            line: startLine,
            endLine: startLine,
        });
        return;
    }
    if (token.type === "code") {
        const codeToken = token as Token & { lang?: string };
        into.push({
            name: codeToken.lang && codeToken.lang.length > 0 ? codeToken.lang : "code",
            kind: "module",
            line: startLine,
            endLine,
        });
    }
}

function countNewlines(s: string): number {
    let n = 0;
    for (let i = 0; i < s.length; i += 1) {
        if (s.charCodeAt(i) === 0x0a) n += 1;
    }
    return n;
}

// Number of distinct lines the string's content occupies. A trailing newline
// terminates its own line and doesn't add a new one (so "X\n" is 1 line, not 2).
// Empty string is 0 lines.
function countLinesSpanned(s: string): number {
    if (s.length === 0) return 0;
    const lastIdx = s.length - 1;
    let n = 1;
    for (let i = 0; i < lastIdx; i += 1) {
        if (s.charCodeAt(i) === 0x0a) n += 1;
    }
    return n;
}
