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

export interface HandlerOptions {
    tokenize?: TokenizeFn;
}

export interface ExtractionVisitor {
    visit(tree: unknown): unknown;
    readonly symbols: MimeSymbol[];
}

export interface Registry {
    readonly byExtension: ReadonlyMap<string, string>;
    readonly byFilename: ReadonlyMap<string, string>;
}

export interface DetectInput {
    path?: string;
    ext?: string;
    hint?: string;
    content?: string;
}

export interface HandlerInfo {
    mimetype: string;
    glyph: string;
    packageName: string;
    extensions: readonly string[];
}

export interface Discovery {
    registry: Registry;
    handlers: ReadonlyMap<string, HandlerInfo>;
}

export interface DiscoverOptions {
    packageDirs?: string[];
    cwd?: string;
}
