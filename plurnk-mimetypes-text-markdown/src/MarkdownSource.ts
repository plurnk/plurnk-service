import { Lexer, Tokenizer, type Token, type TokensList } from "marked";
import { TextCoordinates, type TextRegion } from "@plurnk/plurnk-mimetypes";

const BLOCK_METHODS = ["space", "code", "fences", "heading", "hr", "blockquote", "list", "html", "def", "table", "lheading", "paragraph", "text"] as const;

// {§mimetype-query-conformance} Marked normalizes line endings and transforms nested
// block inputs. Its public tokenizer callbacks locate top-level tokens without
// searching for repeated text or assigning transformed children their parent's span.
export default class MarkdownSource extends Lexer {
    readonly #context: { depth: number; length: number };
    readonly #starts: WeakMap<Token, number>;
    readonly #coordinates: TextCoordinates;
    readonly #content: string;

    constructor(content: string) {
        const normalized = content.replace(/\r\n?/g, "\n");
        const context = { depth: 0, length: normalized.length };
        const starts = new WeakMap<Token, number>();
        const tokenizer = new Tokenizer();
        for (const name of BLOCK_METHODS) {
            const tokenize = tokenizer[name].bind(tokenizer);
            Object.defineProperty(tokenizer, name, { value: (source: string) => {
                const depth = context.depth;
                const token = tokenize(source);
                if (depth === 1 && token !== undefined) starts.set(token, context.length - source.length);
                return token;
            } });
        }
        super({ tokenizer });
        this.#context = context;
        this.#starts = starts;
        this.#coordinates = new TextCoordinates(normalized);
        this.#content = normalized;
        this.lex(normalized);
    }

    override blockTokens(source: string, tokens?: TokensList, lastParagraphClipped?: boolean): TokensList;
    override blockTokens(source: string, tokens?: Token[], lastParagraphClipped?: boolean): Token[];
    override blockTokens(source: string, tokens?: Token[], lastParagraphClipped?: boolean): Token[] {
        this.#context.depth += 1;
        try {
            return super.blockTokens(source, tokens, lastParagraphClipped);
        } finally {
            this.#context.depth -= 1;
        }
    }

    region(token: Token): TextRegion | undefined {
        const start = this.#starts.get(token);
        if (start === undefined) return undefined;
        const raw = token.raw.replace(/\n+$/, "");
        if (this.#content.slice(start, start + raw.length) !== raw) throw new Error("Markdown token no longer denotes its source span");
        return this.#coordinates.regionFromOffsets(start, start + raw.length) ?? undefined;
    }
}
