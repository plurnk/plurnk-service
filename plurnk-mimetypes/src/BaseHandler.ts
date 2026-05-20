import { defaultTokenize } from "./defaults.ts";
import { format } from "./format.ts";
import { fit } from "./fit.ts";
import type { HandlerMetadata, HandlerOptions, MimeSymbol, TokenizeFn } from "./types.ts";

export default class BaseHandler {
    readonly mimetype: string;
    readonly glyph: string;
    readonly extensions: readonly string[];
    readonly #tokenize: TokenizeFn;

    constructor(metadata: HandlerMetadata, options: HandlerOptions = {}) {
        this.mimetype = metadata.mimetype;
        this.glyph = metadata.glyph;
        this.extensions = Object.freeze([...metadata.extensions]);
        this.#tokenize = options.tokenize ?? defaultTokenize;
    }

    extract(_content: string): MimeSymbol[] {
        return [];
    }

    validate(_content: string): void {
        // Default: anything is valid. Override for mimetypes with real syntax.
    }

    symbols(content: string): string {
        return format(this.extract(content));
    }

    async preview(content: string, budget: number): Promise<string> {
        return fit(this.extract(content), budget, this.#tokenize);
    }
}
