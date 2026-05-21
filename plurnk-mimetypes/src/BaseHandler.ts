import { defaultTokenize } from "./defaults.ts";
import { format } from "./format.ts";
import { fit } from "./fit.ts";
import type { HandlerMetadata, HandlerOptions, MimeSymbol, TokenizeFn } from "./types.ts";

// Content shape that handler methods accept. Text mimetypes receive `string`;
// binary mimetypes (PDFs, images, …) receive `Uint8Array`. Handlers declare
// which shape they expect via `plurnk.binary: true` in their package.json.
// The framework's `Mimetypes.process` reads from disk or routes inline content
// to the appropriate shape per handler.
export type HandlerContent = string | Uint8Array;

export default class BaseHandler {
    readonly mimetype: string;
    readonly glyph: string;
    readonly extensions: readonly string[];
    // Exposed (protected-by-convention) so handlers that need a custom
    // preview() implementation — typically those producing transformed
    // content rather than a symbol-formatted outline (HTML→markdown,
    // PDF→text, etc.) — can reach the injected tokenizer to budget their
    // own output. Default preview() uses it internally via fit().
    protected readonly tokenize: TokenizeFn;

    constructor(metadata: HandlerMetadata, options: HandlerOptions = {}) {
        this.mimetype = metadata.mimetype;
        this.glyph = metadata.glyph;
        this.extensions = Object.freeze([...metadata.extensions]);
        this.tokenize = options.tokenize ?? defaultTokenize;
    }

    extract(_content: HandlerContent): MimeSymbol[] {
        return [];
    }

    validate(_content: HandlerContent): void {
        // Default: anything is valid. Override for mimetypes with real syntax.
    }

    symbols(content: HandlerContent): string {
        return format(this.extract(content));
    }

    async preview(content: HandlerContent, budget: number): Promise<string> {
        return fit(this.extract(content), budget, this.tokenize);
    }
}
