import { BaseHandler } from "@plurnk/plurnk-mimetypes";
import type { MimeSymbol } from "@plurnk/plurnk-mimetypes";
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
// validate() inherits BaseHandler's no-op default (any string is valid markdown).
export default class TextMarkdown extends BaseHandler {
    extract(content: string): MimeSymbol[] {
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
