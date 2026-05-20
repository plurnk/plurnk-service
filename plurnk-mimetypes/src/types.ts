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

export type TokenizeFn = (text: string) => Promise<number>;

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
