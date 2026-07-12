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
    line: number;        // 1-indexed
    endLine: number;
    // 1-indexed start/end columns (issue #18). Emitted by tree-sitter and
    // ANTLR extraction (both expose positions); optional because hand-rolled
    // scanners may not track columns.
    column?: number;
    endColumn?: number;
    params?: string[];
    level?: number;
    // Qualified path of the enclosing named symbols, dot-joined — `parse`
    // inside class `Parser` carries container "Parser"; a method on a nested
    // class carries "Outer.Inner". Absent for top-level symbols. This is the
    // def-side identity the graph links on (issue #16 D3); line-range nesting
    // (buildTree) remains the render-time mechanism.
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
    // Classified symbol uses collected during the same visit (issue #16 D4 /
    // ANTLR references grind). Optional for back-compat — a visitor that only
    // emits definitions omits it, and AntlrExtractor.references() returns [].
    readonly refs?: MimeRef[];
}

// Classified reference kinds for the references channel (issue #19). Working
// set — the taxonomy freezes against plurnk-service's symbol_refs schema and
// the concrete @-dialect queries it must answer (plurnk-service#186) before
// any extraction engine ships.
export type RefKind =
    | "import"
    | "call"
    | "instantiate"
    | "inherit"
    | "type"
    | "use";

// One symbol *use* (never a definition — defs live in the symbols channel).
// Produced by the references channel (issue #16 D4): the per-entry raw
// material for plurnk-service's symbol_refs rows. `container` is the
// qualified path of the enclosing definition — the source node of the graph
// edge; absent for module-top-level references.
export interface MimeRef {
    name: string;
    kind: RefKind;
    line: number;       // 1-indexed
    column: number;     // 1-indexed
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
    // Where this handler came from. "package" → discovered from a @plurnk/*
    // npm package via discover(); resolved by importing packageName.
    // "treesitter" → built into the framework's tree-sitter registry
    // (SPEC §9.5); resolved by looking up TREE_SITTER_REGISTRY by mimetype
    // and instantiating TreeSitterLanguageHandler with the registry entry.
    // @plurnk packages take precedence — tree-sitter entries only fill in
    // mimetypes that no @plurnk package claims.
    source: "package" | "treesitter";
    // Per-handler navigation declaration (SPEC §20, #43): "line" (addressed by
    // line numbers) or "tree" (structural jsonpath/xpath addressing). Set via
    // `navigation` on the handler entry in the plurnk block. OPTIONAL — absent
    // means the framework's taxonomy heuristic decides (classifyMimetype); a
    // handler declares it only when its algebra defies the taxonomy.
    navigation?: "line" | "tree";
    // Raw `plurnk.attribution` (string | string[]) declared at the top of the
    // package's plurnk block — plugin attribution tags the host unions onto
    // model `generate({ attributions })` calls (issue #37 / plurnk-service#249).
    // Package-level, like `binary`: applies to every handler entry in the
    // package. discover() passes it through verbatim; the host (plurnk-service)
    // applies the reservation policy (`@plurnk/` tags allowed only from
    // `@plurnk/`-scoped packages). Undefined when the package declares none,
    // and always absent for source: "treesitter" (framework built-ins carry no
    // attribution).
    attribution?: string | string[];
}

export interface Discovery {
    registry: Registry;
    handlers: ReadonlyMap<string, HandlerInfo>;
}

export interface DiscoverOptions {
    packageDirs?: string[];
    cwd?: string;
    // When false, skip seeding the framework's built-in tree-sitter
    // language registry. Default true. Tests that need a clean baseline
    // (only @plurnk handler discovery, no tree-sitter defaults) pass
    // false. Production code should leave it default.
    includeTreeSitter?: boolean;
    // Environment for the plugin trust gate (issue #29 / plurnk-service#229).
    // Defaults to process.env. discover() reads PLURNK_PLUGINS_TRUSTED_ONLY:
    // unset/empty/"0" → gate off (every discovered handler registers);
    // a value → gate on, @plurnk/* always trusted plus a comma-separated
    // allowlist of additionally-trusted package names. Injectable for tests.
    env?: Record<string, string | undefined>;
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
// A 1-indexed, inclusive source-line span. The hit's footprint is an array of
// these (issue #41) — one for a contiguous hit, several only when the source is
// genuinely disjoint (gaps preserved, never coalesced).
export interface LineSpan {
    readonly line: number;
    readonly endLine: number;
}

export interface QueryMatch {
    // The structured value at the hit — always present (issue #41).
    readonly matched: unknown;
    // The locus: jsonpath path or xpath expression. Present when meaningful.
    readonly matching?: string;
    // The hit's source-line footprint. Present and accurate for every
    // content-backed match (regex/glob, jsonpath nodes, xpath node selections).
    // ABSENT only for node-less computed scalars (xpath count()/string()/sum()/
    // boolean()) — those synthesize a value out of many nodes (or none) and so
    // live nowhere in the source. We never fake a line for them.
    readonly lines?: ReadonlyArray<LineSpan>;
}
