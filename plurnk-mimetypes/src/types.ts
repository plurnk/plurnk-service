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

// Preview material returned by Handler.preview(). The handler authors the
// preview policy; the framework owns the budget math. Handlers never see the
// token budget or the tokenize function.
//
// Three shapes:
//   - SymbolPreview: structural outline (handler has structure to extract).
//   - TextPreview: oriented text slice (content is inherently flat, or the
//     handler's structural extraction came up empty and a body slice is
//     better than nothing). Framework appends/prepends a [[TRUNCATED]] marker
//     when the slice doesn't fit the full content so the model knows the
//     preview is incomplete and a fetch is needed.
//   - null: handler explicitly declines — no preview signal of any kind.
export type Preview = SymbolPreview | TextPreview | null;

// Structural preview: an outline of symbols. Framework fits via fitSymbols(),
// dropping deepest-first then trailing roots until the budget is met.
export interface SymbolPreview {
    readonly kind: "symbols";
    readonly symbols: readonly MimeSymbol[];
}

// Text preview: oriented content slice.
//
//   orientation: "head" — keep the start, trail with `...[[TRUNCATED]]` when
//                          truncated. Documents, articles, source files,
//                          prose — content read top-down.
//   orientation: "tail" — keep the end, lead with `[[TRUNCATED]]...` when
//                          truncated. Streams, logs, append-only feeds,
//                          diffs — content where recency matters.
export interface TextPreview {
    readonly kind: "text";
    readonly text: string;
    readonly orientation: "head" | "tail";
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

// Body matcher dialects, dispatched by leading-prefix from plurnk-grammar's
// plurnk.md table: `//` xpath, `/.../flags` regex, `$` jsonpath, otherwise
// glob (line-anchored against body text).
export type QueryDialect = "regex" | "glob" | "xpath" | "jsonpath";

// Per-match result shape, per grammar #17. Returned by Handler.query for every
// dialect. Empty result set is `[]` (consumer maps to 204).
//
// `matched` is polymorphic by extractor:
//   - regex bare        → string (the full match)
//   - regex anon captures → readonly string[] (positional captures)
//   - regex named captures → readonly { [name]: string } (named captures; mixed
//     includes positional "1", "2", ... keys)
//   - glob              → string (the matching line)
//   - jsonpath          → the matched value (any JSON shape)
//   - xpath text/attr   → string
//   - xpath element     → string (serialized XML)
//
// `matching` is the resolved canonical locator for multi-match dialects:
//   - jsonpath wildcards → `$.users[0].name` per match
//   - xpath multi-match → `(//user)[1]` per match
//   - omitted otherwise.
export interface QueryMatch {
    readonly line: number;
    readonly matched: unknown;
    readonly matching?: string;
}
