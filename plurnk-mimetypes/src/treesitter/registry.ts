import type { TreeSitterSymbolProjection } from "../ParserCoordinates.ts";
import type { TreeSitterNode } from "../TreeSitterExtractor.ts";

// One entry per tree-sitter-supported language. The framework's registry
// lists every language we expose via web-tree-sitter. Mapping files are
// lazy-loaded (see `importMapping`) so a consumer only pays the import
// cost for languages they actually use.
export interface TreeSitterLanguageEntry {
    /** Mimetype to register for detection + dispatch. */
    readonly mimetype: string;
    /** Display glyph. */
    readonly glyph: string;
    /** File extensions / filenames this entry claims (lowercased on match). */
    readonly extensions: readonly string[];
    /**
     * Short language slug — used to construct the plurnk grammar package name
     * (`@plurnk/plurnk-mimetypes-grammar-{slug}`) and the bundled WASM file
     * name (`{slug}.wasm`).
     */
    readonly slug: string;
    /**
     * Dynamic-import factory for the mapping module. The module must
     * export `extract(root, content)` returning semantic symbol projections.
     */
    readonly importMapping: () => Promise<TreeSitterLanguageMapping>;
}

export interface TreeSitterLanguageMapping {
    extract(root: TreeSitterNode, content: string): TreeSitterSymbolProjection[];
    // Optional override for the deep-json channel (issue #10). When present,
    // TreeSitterLanguageHandler.deepJson() bypasses the default tree-sitter
    // AST walker and uses this function instead. Used by languages where the
    // algebra-natural deep-json shape is the parsed value rather than the
    // AST — YAML, TOML, JSON, CSV. The default walker (walkDeepNode) is the
    // right answer for code-shaped languages where the AST IS what users
    // want to query.
    deepJson?(content: string): unknown | Promise<unknown>;
    // Optional references-channel query (issue #19): tree-sitter query
    // source (S-expression patterns) whose `@ref.<kind>` captures yield the
    // classified symbol uses. Lives in src/treesitter/queries/{slug}.ts as
    // an embedded string (reviewable .scm content without a build-time copy
    // step) and is re-exported by the mapping module. Languages without a
    // query serve an empty references channel.
    refsQuery?: string;
}

// Built-in tree-sitter language registry. Order is not significant; lookup
// is by mimetype. Add entries here when porting a new language; the mapping
// file lives at `src/treesitter/<short-name>.ts`.
export const TREE_SITTER_REGISTRY: readonly TreeSitterLanguageEntry[] = [
    {
        mimetype: "text/x-python",
        glyph: "🐍",
        extensions: [".py", ".pyw"],
        slug: "python",
        importMapping: () => import("./python.ts"),
    },
    {
        mimetype: "text/x-haskell",
        glyph: "λ",
        extensions: [".hs", ".lhs"],
        slug: "haskell",
        importMapping: () => import("./haskell.ts"),
    },
    {
        mimetype: "text/x-ruby",
        glyph: "💎",
        extensions: [".rb", ".rake", ".gemspec", "Rakefile", "Gemfile"],
        slug: "ruby",
        importMapping: () => import("./ruby.ts"),
    },
    {
        mimetype: "text/x-shellscript",
        glyph: "🐚",
        extensions: [".sh", ".bash", ".zsh", ".bashrc", ".zshrc"],
        slug: "bash",
        importMapping: () => import("./bash.ts"),
    },
    {
        mimetype: "text/x-ocaml",
        glyph: "🐫",
        extensions: [".ml", ".mli"],
        slug: "ocaml",
        importMapping: () => import("./ocaml.ts"),
    },
    {
        mimetype: "text/x-java",
        glyph: "☕",
        extensions: [".java"],
        slug: "java",
        importMapping: () => import("./java.ts"),
    },
    {
        mimetype: "text/x-go",
        glyph: "🐹",
        extensions: [".go"],
        slug: "go",
        importMapping: () => import("./go.ts"),
    },
    {
        mimetype: "text/x-rust",
        glyph: "🦀",
        extensions: [".rs"],
        slug: "rust",
        importMapping: () => import("./rust.ts"),
    },
    {
        mimetype: "text/x-c",
        glyph: "🇨",
        extensions: [".c", ".h"],
        slug: "c",
        importMapping: () => import("./c.ts"),
    },
    {
        mimetype: "text/x-cpp",
        glyph: "🇨",
        extensions: [".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx", ".h++"],
        slug: "cpp",
        importMapping: () => import("./cpp.ts"),
    },
    {
        // Linguist's C++ convention. Hint-only —
        // extension detection stays with the canonical text/x-cpp entry.
        mimetype: "text/x-c++src",
        glyph: "🇨",
        extensions: [],
        slug: "cpp",
        importMapping: () => import("./cpp.ts"),
    },
    {
        mimetype: "text/javascript",
        glyph: "🟨",
        extensions: [".js", ".mjs", ".cjs"],
        slug: "javascript",
        importMapping: () => import("./javascript.ts"),
    },
    {
        mimetype: "text/typescript",
        glyph: "🟦",
        extensions: [".ts", ".mts", ".cts"],
        slug: "typescript",
        importMapping: () => import("./typescript.ts"),
    },
    {
        mimetype: "text/x-tsx",
        glyph: "🟦",
        extensions: [".tsx", ".jsx"],
        slug: "tsx",
        importMapping: () => import("./tsx.ts"),
    },
    {
        // Deno's canonical TSX name
        // (consistent with our Deno-sourced text/typescript). Hint-only.
        mimetype: "text/tsx",
        glyph: "🟦",
        extensions: [],
        slug: "tsx",
        importMapping: () => import("./tsx.ts"),
    },
    {
        mimetype: "text/x-php",
        glyph: "🐘",
        extensions: [".php", ".phtml", ".php3", ".php4", ".php5", ".php7", ".phps"],
        slug: "php",
        importMapping: () => import("./php.ts"),
    },
    {
        mimetype: "text/x-scala",
        glyph: "🇸",
        extensions: [".scala", ".sc"],
        slug: "scala",
        importMapping: () => import("./scala.ts"),
    },
    {
        mimetype: "text/x-elixir",
        glyph: "💧",
        extensions: [".ex", ".exs"],
        slug: "elixir",
        importMapping: () => import("./elixir.ts"),
    },
    {
        mimetype: "text/x-dart",
        glyph: "🎯",
        extensions: [".dart"],
        slug: "dart",
        importMapping: () => import("./dart.ts"),
    },
    {
        mimetype: "text/x-julia",
        glyph: "🟣",
        extensions: [".jl"],
        slug: "julia",
        importMapping: () => import("./julia.ts"),
    },
    {
        mimetype: "text/x-fsharp",
        glyph: "♯",
        extensions: [".fs", ".fsx"],
        slug: "fsharp",
        importMapping: () => import("./fsharp.ts"),
    },
    {
        mimetype: "text/x-fsharp-signature",
        glyph: "♯",
        extensions: [".fsi"],
        slug: "fsharp-signature",
        importMapping: () => import("./fsharp.ts"),
    },
    {
        mimetype: "text/x-makefile",
        glyph: "🔨",
        extensions: [".mk", "Makefile", "makefile", "GNUmakefile"],
        slug: "make",
        importMapping: () => import("./make.ts"),
    },
    {
        mimetype: "text/x-lua",
        glyph: "🌙",
        extensions: [".lua"],
        slug: "lua",
        importMapping: () => import("./lua.ts"),
    },
    {
        mimetype: "text/x-kotlin",
        glyph: "🇰",
        extensions: [".kt", ".kts"],
        slug: "kotlin",
        importMapping: () => import("./kotlin.ts"),
    },
    {
        mimetype: "text/x-zig",
        glyph: "⚡",
        extensions: [".zig", ".zon"],
        slug: "zig",
        importMapping: () => import("./zig.ts"),
    },
    {
        mimetype: "application/yaml",
        glyph: "📄",
        extensions: [".yaml", ".yml"],
        slug: "yaml",
        importMapping: () => import("./yaml.ts"),
    },
    {
        mimetype: "application/toml",
        glyph: "📄",
        extensions: [".toml"],
        slug: "toml",
        importMapping: () => import("./toml.ts"),
    },
    {
        mimetype: "text/x-odin",
        glyph: "🪶",
        extensions: [".odin"],
        slug: "odin",
        importMapping: () => import("./odin.ts"),
    },
    {
        mimetype: "text/css",
        glyph: "🎨",
        extensions: [".css"],
        slug: "css",
        importMapping: () => import("./css.ts"),
    },
];

// Look up a registry entry by mimetype. Returns null if the mimetype
// isn't covered by the built-in tree-sitter set (caller falls through to
// @plurnk/* handler-package discovery).
export function lookupTreeSitterLanguage(mimetype: string): TreeSitterLanguageEntry | null {
    for (const entry of TREE_SITTER_REGISTRY) {
        if (entry.mimetype === mimetype) return entry;
    }
    return null;
}
