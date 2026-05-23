import { format } from "./format.ts";
import type { HandlerMetadata, MimeSymbol, Preview } from "./types.ts";

// Content shape that handler methods accept. Text mimetypes receive `string`;
// binary mimetypes (PDF, images, archives) receive `Uint8Array`. Handlers
// signal which via `plurnk.binary: true` in their package.json. The framework
// reads files (or routes inline content) to the appropriate shape per handler.
export type HandlerContent = string | Uint8Array;

// Base class for mimetype handlers. Subclasses author preview policy by
// overriding `preview(content)` (and `validate(content)` when the mimetype
// has a real syntax check). The framework owns budget math and tokenization
// entirely — handlers never see budget or tokenize values.
//
// Diagnostic access (extractRaw, symbolsRaw) is available via getHandler()
// for consumers needing the unbudgeted structural data. Naming intentionally
// signals "Plan B" — the canonical interface is `Mimetypes.process` which
// returns the framework-fitted preview.
export default class BaseHandler {
    readonly mimetype: string;
    readonly glyph: string;
    readonly extensions: readonly string[];

    constructor(metadata: HandlerMetadata) {
        this.mimetype = metadata.mimetype;
        this.glyph = metadata.glyph;
        this.extensions = Object.freeze([...metadata.extensions]);
    }

    // Raw structural extraction. Default returns []. Subclasses override for
    // mimetypes with structural content.
    extractRaw(_content: HandlerContent): MimeSymbol[] {
        return [];
    }

    // Throw on malformed content. Default no-op. Sync or async; the framework
    // awaits the result either way.
    validate(_content: HandlerContent): void | Promise<void> {
        // Default: anything is valid.
    }

    // Unbudgeted structural rendering — `format(extractRaw(content))` by
    // default. Diagnostic access; not the primary surface (see preview).
    symbolsRaw(content: HandlerContent): string {
        return format(this.extractRaw(content));
    }

    // The handler's preview policy. Returns:
    //   - SymbolPreview: structural outline (framework fits via fit())
    //   - TextPreview:   raw text with orientation (framework fits via fitContent())
    //   - null:          no preview (handler explicitly declines)
    //
    // Default: SymbolPreview wrapping extractRaw output. Handlers with text
    // content (PDF extracted text, HTML→markdown, plain-text bodies, etc.)
    // override to return TextPreview with the appropriate orientation.
    preview(content: HandlerContent): Preview | Promise<Preview> {
        return { kind: "symbols", symbols: this.extractRaw(content) };
    }
}
