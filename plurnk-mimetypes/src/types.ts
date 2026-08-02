import type { TextRegion } from "@plurnk/plurnk-contracts";

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
    // Optional together under {§text-region}.
    column?: number;
    endColumn?: number;
    params?: string[];
    level?: number;
    // Qualified enclosing definition path ({§mimetype-symbol-container}).
    container?: string;
}

export interface HandlerMetadata {
    mimetype: string;
    glyph: string;
    extensions: readonly string[];
}

export interface ExtractionVisitor {
    visit(tree: unknown): unknown;
    readonly symbols: MimeSymbol[];
    // Optional classified uses from the same traversal.
    readonly refs?: MimeRef[];
}

// Closed reference vocabulary ({§mimetype-references}).
export type RefKind =
    | "import"
    | "call"
    | "instantiate"
    | "inherit"
    | "type"
    | "use";

// One symbol use, with an optional enclosing definition path
// ({§mimetype-references}, {§mimetype-reference-container}).
export interface MimeRef {
    name: string;
    kind: RefKind;
    line: number;
    column: number;
    endLine: number;
    endColumn: number;
    container?: string;
}

export interface Registry {
    readonly byExtension: ReadonlyMap<string, string>;
    readonly byFilename: ReadonlyMap<string, string>;
}

export interface DetectInput {
    path?: string;
    ext?: string;
    hint?: string;
}

export interface HandlerInfo {
    mimetype: string;
    glyph: string;
    packageName: string;
    extensions: readonly string[];
    // Package-level file-decoding declaration ({§mimetype-handler-content}).
    binary: boolean;
    // Package-discovered handler or framework tree-sitter registry entry.
    source: "package" | "treesitter";
    // Normalized package attribution; framework registry entries omit it.
    attribution?: string | string[];
}

export interface Discovery {
    registry: Registry;
    handlers: ReadonlyMap<string, HandlerInfo>;
    // Package names withheld by the shared trust predicate before handler code
    // can be imported. The consumer owns how this evidence is presented.
    skipped: readonly string[];
}

export interface DiscoverOptions {
    packageDirs?: string[];
    cwd?: string;
    // When false, skip seeding the framework's built-in tree-sitter
    // language registry. Default true. Tests that need a clean baseline
    // (only @plurnk handler discovery, no tree-sitter defaults) pass
    // false. Production code should leave it default.
    includeTreeSitter?: boolean;
    // Injectable trust environment ({§plugin-trust-boundary}); defaults to
    // process.env.
    env?: Record<string, string | undefined>;
}

// Parsed body-matcher dialect vocabulary ({§mimetype-query}).
export type QueryDialect = "regex" | "glob" | "xpath" | "jsonpath";

// Internal inclusive parser provenance used to derive query evidence.
export interface LineSpan {
    readonly line: number;
    readonly endLine: number;
}

export interface QueryMatch {
    // Extractor result value; always present.
    readonly matched: unknown;
    // Canonical structural locator when meaningful.
    readonly matching?: string;
    // Honest readable-text evidence ({§mimetype-query-conformance}).
    readonly regions?: ReadonlyArray<TextRegion>;
}
