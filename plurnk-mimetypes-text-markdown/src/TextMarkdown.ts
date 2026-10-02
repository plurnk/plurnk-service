import { BaseHandler, TextCoordinates, type TextRegion } from "@plurnk/plurnk-mimetypes";
import type { HandlerContent, MimeSymbol } from "@plurnk/plurnk-mimetypes";
import { Lexer, type Token } from "marked";
import { parseDocument } from "yaml";
import MarkdownSource from "./MarkdownSource.ts";

// text/markdown handler. marked's lexer handles ATX and setext headings,
// leading whitespace edge cases, and code-fence positions.
//
// Symbols emitted:
//   - heading: every heading at every depth, with `level` from token.depth
//   - module:  every fenced code block, named by its language tag (or "code"
//              when no language), with line range covering the full fence
//
// container ({§mimetype-symbol-container}): the dotted path of the open ancestor
// headings — a lower `level` opens an ancestor scope; a heading at level N
// closes every open heading at level >= N. Top-level symbols omit the key.
// Heading names are used verbatim as path segments (may contain dots).
// Source spans come from the lexer callbacks, not rendered Markdown.
//
// validate() inherits BaseHandler's no-op default (any string is valid markdown).
export default class TextMarkdown extends BaseHandler {
    override summary(content: HandlerContent): string | undefined {
        if (typeof content !== "string") return undefined;
        const frontmatter = /^---\r?\n([\s\S]*?)^---(?:\r?\n|$)/mu.exec(content);
        if (frontmatter?.index === 0) {
            const document = parseDocument(frontmatter[1], { uniqueKeys: true });
            // Malformed frontmatter is still legal Markdown, but not metadata.
            if (document.errors.length === 0) {
                const description = document.get("description");
                if (typeof description === "string" && description.trim().length > 0) return description;
            }
        }
        const tokens = new Lexer().lex(content);
        const headingIndex = tokens.findIndex((token) => {
            if (token.type !== "heading") return false;
            const heading = token as Token & { depth: number; text: string };
            return heading.depth === 2 && heading.text === "Summary";
        });
        if (headingIndex === -1) return undefined;
        for (const token of tokens.slice(headingIndex + 1)) {
            if (token.type === "space") continue;
            if (token.type !== "paragraph") return undefined;
            return (token as Token & { text: string }).text;
        }
        return undefined;
    }

    override extractRaw(content: string): MimeSymbol[] {
        const source = new MarkdownSource(content);
        const symbols: MimeSymbol[] = [];
        // Stack of open headings, strictly increasing in level.
        const open: Array<{ level: number; name: string }> = [];
        for (const token of source.tokens) {
            const region = source.region(token);
            if (region !== undefined) emitFor(token, region, symbols, open);
        }

        return symbols;
    }

    // Deep-channel ({§mimetype-channel-architecture}). The markdown AST as nested objects — heading,
    // paragraph, list, code block, blockquote, etc. — preserves enough
    // structure for jsonpath like `$..[?(@.type=='code' && @.lang=='ts')]` or
    // `$..[?(@.type=='heading' && @.level==1)]`. Each node carries `type`, `line`, `endLine`,
    // plus its native marked fields (depth/text/lang/items/etc.).
    //
    // Returned as `{ type: "document", children: [...] }` so it presents as a
    // single rooted tree (matches the deep-xml projection: <document>...</document>).
    override deepJson(content: HandlerContent): unknown {
        if (typeof content !== "string") return null;
        const source = new MarkdownSource(content);
        const children = source.tokens.map((token) => tokenToDeep(token, source.region(token)));
        const region = TextCoordinates.regionFromOffsets(content, 0, content.length)!;
        return { type: "document", ...coordinates(region), children };
    }
}

// Convert one marked token into a deep-tree node. Pulls the fields jsonpath
// users actually want to query (type, depth, text, lang, items) into named
// properties; drops parser-internal cursors that aren't queryable.
function tokenToDeep(token: Token, region: TextRegion | undefined, enclosing?: TextRegion): Record<string, unknown> {
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
    const node: Record<string, unknown> = {
        type: t.type,
        ...(region === undefined ? enclosing === undefined ? {} : { line: enclosing.startLine, endLine: enclosing.endLine } : coordinates(region)),
    };
    if (typeof t.depth === "number") {
        node.level = t.depth;
        // The heading level also rides as a content attribute, so `//heading[@level='2']`
        // selects by level without the provenance prefix.
        node.attrs = { level: t.depth };
    }
    if (typeof t.text === "string" && t.text.length > 0) node.text = t.text;
    if (typeof t.lang === "string" && t.lang.length > 0) node.lang = t.lang;
    if (typeof t.href === "string") node.href = t.href;
    if (typeof t.title === "string") node.title = t.title;
    if (typeof t.ordered === "boolean") node.ordered = t.ordered;

    // Recurse into nested token trees (list items, paragraph inlines).
    // We don't track precise inner line ranges — parent's range covers them.
    const innerSource = t.items ?? t.tokens;
    if (Array.isArray(innerSource) && innerSource.length > 0) {
        node.children = innerSource.map((child) => tokenToDeep(child, undefined, region ?? enclosing));
    }
    return node;
}

function emitFor(
    token: Token,
    region: TextRegion,
    into: MimeSymbol[],
    open: Array<{ level: number; name: string }>,
): void {
    if (token.type === "heading") {
        const headingToken = token as Token & { depth: number; text: string };
        // A heading at level N closes every open heading at level >= N; its
        // container is the dotted path of what remains open.
        while (open.length > 0 && open[open.length - 1].level >= headingToken.depth) {
            open.pop();
        }
        const container = open.map((o) => o.name).join(".");
        into.push({
            name: headingToken.text,
            kind: "heading",
            level: headingToken.depth,
            ...coordinates(region),
            ...(container.length > 0 && { container }),
        });
        open.push({ level: headingToken.depth, name: headingToken.text });
        return;
    }
    if (token.type === "code") {
        const codeToken = token as Token & { lang?: string };
        const container = open.map((o) => o.name).join(".");
        into.push({
            name: codeToken.lang && codeToken.lang.length > 0 ? codeToken.lang : "code",
            kind: "module",
            ...coordinates(region),
            ...(container.length > 0 && { container }),
        });
    }
}

function coordinates(region: TextRegion): { line: number; column: number; endLine: number; endColumn: number } {
    return { line: region.startLine, column: region.startColumn, endLine: region.endLine, endColumn: region.endColumn };
}
