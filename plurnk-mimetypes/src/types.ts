export type SymbolKind =
    | "class"
    | "function"
    | "method"
    | "field"
    | "interface"
    | "enum"
    | "type"
    | "module"
    | "variable"
    | "constant"
    | "heading";

export interface MimeSymbol {
    name: string;
    kind: SymbolKind;
    line: number;
    endLine: number;
    params?: string[];
    level?: number;
}

export interface HandlerMetadata {
    mimetype: string;
    glyph: string;
    extensions: readonly string[];
}

// Tokenize functions may be sync or async. Sync providers (most WASM-backed
// tokenizers — tiktoken-js, llama-tokenizer-js, cl100k, etc.) return number
// directly; genuinely-async providers (e.g., Gemini's REST countTokens)
// return Promise<number>. All internal call sites `await` the result, which
// is a no-op for non-thenables. (plurnk/plurnk-mimetypes#1.)
export type TokenizeFn = (text: string) => number | Promise<number>;

export interface ExtractionVisitor {
    visit(tree: unknown): unknown;
    readonly symbols: MimeSymbol[];
}

// Preview material returned by Handler.preview(). The handler is the sole
// author of structural symbols; the framework owns the budget math. Handlers
// never see budget or tokenize values. There is no raw-text preview branch
// by design: the radar is a passive structural signal, not a body slice.
// Mimetypes without a structural extraction path return null.
export type Preview = SymbolPreview | null;

// Structural preview: an outline of symbols. Framework fits via fitSymbols(),
// dropping deepest-first then trailing roots until the budget is met.
export interface SymbolPreview {
    readonly kind: "symbols";
    readonly symbols: readonly MimeSymbol[];
}

export interface Registry {
    readonly byExtension: ReadonlyMap<string, string>;
    readonly byFilename: ReadonlyMap<string, string>;
}

export interface DetectInput {
    path?: string;
    ext?: string;
    hint?: string;
    // Raw content for magic-byte sniffing. Accepts string or Uint8Array since
    // sniffing is most useful for binary mimetypes. Currently not consumed by
    // detect() — reserved for the future content-sniffing lane.
    content?: string | Uint8Array;
}

export interface HandlerInfo {
    mimetype: string;
    glyph: string;
    packageName: string;
    extensions: readonly string[];
    // When true, the framework reads file content as Uint8Array (not utf-8
    // string) before passing to handler methods. Set via `plurnk.binary: true`
    // at the top of the package's plurnk block — applies to all handler
    // entries in the package.
    binary: boolean;
}

export interface Discovery {
    registry: Registry;
    handlers: ReadonlyMap<string, HandlerInfo>;
}

export interface DiscoverOptions {
    packageDirs?: string[];
    cwd?: string;
}
