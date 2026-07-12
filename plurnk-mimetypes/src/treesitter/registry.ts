import type { MimeSymbol } from "../types.ts";
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
     * name (`{slug}.wasm`). The framework prefers this path first.
     */
    readonly slug: string;
    /**
     * Legacy upstream npm package name and WASM file path inside it. The
     * framework falls back to this if the plurnk grammar package isn't
     * installed — keeps the ecosystem working during the transition. Both
     * fields can be null for languages that never had an upstream WASM-ready
     * package (e.g. Tier 2 candidates from earlier).
     */
    readonly wasmPackage: string | null;
    readonly wasmFile: string | null;
    /**
     * Dynamic-import factory for the mapping module. The module must
     * export `extract(root, content)` returning MimeSymbol[].
     */
    readonly importMapping: () => Promise<TreeSitterLanguageMapping>;
}

export interface TreeSitterLanguageMapping {
    extract(root: TreeSitterNode, content: string): MimeSymbol[];
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
        wasmPackage: "tree-sitter-python",
        wasmFile: "tree-sitter-python.wasm",
        importMapping: () => import("./python.ts"),
    },
    {
        mimetype: "text/x-haskell",
        glyph: "λ",
        extensions: [".hs", ".lhs"],
        slug: "haskell",
        wasmPackage: "tree-sitter-haskell",
        wasmFile: "tree-sitter-haskell.wasm",
        importMapping: () => import("./haskell.ts"),
    },
    {
        mimetype: "text/x-ruby",
        glyph: "💎",
        extensions: [".rb", ".rake", ".gemspec", "Rakefile", "Gemfile"],
        slug: "ruby",
        wasmPackage: "tree-sitter-ruby",
        wasmFile: "tree-sitter-ruby.wasm",
        importMapping: () => import("./ruby.ts"),
    },
    {
        mimetype: "text/x-shellscript",
        glyph: "🐚",
        extensions: [".sh", ".bash", ".zsh", ".bashrc", ".zshrc"],
        slug: "bash",
        wasmPackage: "tree-sitter-bash",
        wasmFile: "tree-sitter-bash.wasm",
        importMapping: () => import("./bash.ts"),
    },
    {
        mimetype: "text/x-ocaml",
        glyph: "🐫",
        extensions: [".ml", ".mli"],
        slug: "ocaml",
        wasmPackage: "tree-sitter-ocaml",
        wasmFile: "tree-sitter-ocaml.wasm",
        importMapping: () => import("./ocaml.ts"),
    },
    {
        mimetype: "text/x-java",
        glyph: "☕",
        extensions: [".java"],
        slug: "java",
        wasmPackage: "tree-sitter-java",
        wasmFile: "tree-sitter-java.wasm",
        importMapping: () => import("./java.ts"),
    },
    {
        mimetype: "text/x-go",
        glyph: "🐹",
        extensions: [".go"],
        slug: "go",
        wasmPackage: "tree-sitter-go",
        wasmFile: "tree-sitter-go.wasm",
        importMapping: () => import("./go.ts"),
    },
    {
        mimetype: "text/x-rust",
        glyph: "🦀",
        extensions: [".rs"],
        slug: "rust",
        wasmPackage: "tree-sitter-rust",
        wasmFile: "tree-sitter-rust.wasm",
        importMapping: () => import("./rust.ts"),
    },
    {
        mimetype: "text/x-c",
        glyph: "🇨",
        extensions: [".c", ".h"],
        slug: "c",
        wasmPackage: "tree-sitter-c",
        wasmFile: "tree-sitter-c.wasm",
        importMapping: () => import("./c.ts"),
    },
    {
        mimetype: "text/x-cpp",
        glyph: "🇨",
        extensions: [".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx", ".h++"],
        slug: "cpp",
        wasmPackage: "tree-sitter-cpp",
        wasmFile: "tree-sitter-cpp.wasm",
        importMapping: () => import("./cpp.ts"),
    },
    {
        mimetype: "text/javascript",
        glyph: "🟨",
        extensions: [".js", ".mjs", ".cjs"],
        slug: "javascript",
        wasmPackage: "tree-sitter-javascript",
        wasmFile: "tree-sitter-javascript.wasm",
        importMapping: () => import("./javascript.ts"),
    },
    {
        mimetype: "text/typescript",
        glyph: "🟦",
        extensions: [".ts", ".mts", ".cts"],
        slug: "typescript",
        wasmPackage: "tree-sitter-typescript",
        wasmFile: "tree-sitter-typescript.wasm",
        importMapping: () => import("./typescript.ts"),
    },
    {
        mimetype: "text/x-tsx",
        glyph: "🟦",
        extensions: [".tsx", ".jsx"],
        slug: "tsx",
        wasmPackage: "tree-sitter-typescript",
        wasmFile: "tree-sitter-tsx.wasm",
        importMapping: () => import("./tsx.ts"),
    },
    {
        mimetype: "text/x-php",
        glyph: "🐘",
        extensions: [".php", ".phtml", ".php3", ".php4", ".php5", ".php7", ".phps"],
        slug: "php",
        wasmPackage: "tree-sitter-php",
        wasmFile: "tree-sitter-php.wasm",
        importMapping: () => import("./php.ts"),
    },
    {
        mimetype: "text/x-scala",
        glyph: "🇸",
        extensions: [".scala", ".sc"],
        slug: "scala",
        wasmPackage: "tree-sitter-scala",
        wasmFile: "tree-sitter-scala.wasm",
        importMapping: () => import("./scala.ts"),
    },
    {
        mimetype: "text/x-elixir",
        glyph: "💧",
        extensions: [".ex", ".exs"],
        slug: "elixir",
        wasmPackage: "tree-sitter-elixir",
        wasmFile: "tree-sitter-elixir.wasm",
        importMapping: () => import("./elixir.ts"),
    },
    {
        mimetype: "text/x-dart",
        glyph: "🎯",
        extensions: [".dart"],
        slug: "dart",
        wasmPackage: "tree-sitter-dart",
        wasmFile: "tree-sitter-dart.wasm",
        importMapping: () => import("./dart.ts"),
    },
    {
        mimetype: "text/x-julia",
        glyph: "🟣",
        extensions: [".jl"],
        slug: "julia",
        wasmPackage: "tree-sitter-julia",
        wasmFile: "tree-sitter-julia.wasm",
        importMapping: () => import("./julia.ts"),
    },
    {
        mimetype: "text/x-fsharp",
        glyph: "♯",
        extensions: [".fs", ".fsx"],
        slug: "fsharp",
        wasmPackage: "tree-sitter-fsharp",
        wasmFile: "tree-sitter-fsharp.wasm",
        importMapping: () => import("./fsharp.ts"),
    },
    {
        mimetype: "text/x-fsharp-signature",
        glyph: "♯",
        extensions: [".fsi"],
        slug: "fsharp-signature",
        wasmPackage: "tree-sitter-fsharp",
        wasmFile: "tree-sitter-fsharp_signature.wasm",
        importMapping: () => import("./fsharp.ts"),
    },
    {
        mimetype: "text/x-makefile",
        glyph: "🔨",
        extensions: [".mk", "Makefile", "makefile", "GNUmakefile"],
        slug: "make",
        wasmPackage: "tree-sitter-make",
        wasmFile: "tree-sitter-make.wasm",
        importMapping: () => import("./make.ts"),
    },
    {
        mimetype: "text/x-lua",
        glyph: "🌙",
        extensions: [".lua"],
        slug: "lua",
        wasmPackage: "@tree-sitter-grammars/tree-sitter-lua",
        wasmFile: "tree-sitter-lua.wasm",
        importMapping: () => import("./lua.ts"),
    },
    {
        mimetype: "text/x-kotlin",
        glyph: "🇰",
        extensions: [".kt", ".kts"],
        slug: "kotlin",
        wasmPackage: "@tree-sitter-grammars/tree-sitter-kotlin",
        wasmFile: "tree-sitter-kotlin.wasm",
        importMapping: () => import("./kotlin.ts"),
    },
    {
        mimetype: "text/x-zig",
        glyph: "⚡",
        extensions: [".zig", ".zon"],
        slug: "zig",
        wasmPackage: "@tree-sitter-grammars/tree-sitter-zig",
        wasmFile: "tree-sitter-zig.wasm",
        importMapping: () => import("./zig.ts"),
    },
    {
        mimetype: "application/yaml",
        glyph: "📄",
        extensions: [".yaml", ".yml"],
        slug: "yaml",
        wasmPackage: "@tree-sitter-grammars/tree-sitter-yaml",
        wasmFile: "tree-sitter-yaml.wasm",
        importMapping: () => import("./yaml.ts"),
    },
    {
        mimetype: "application/toml",
        glyph: "📄",
        extensions: [".toml"],
        slug: "toml",
        wasmPackage: "@tree-sitter-grammars/tree-sitter-toml",
        wasmFile: "tree-sitter-toml.wasm",
        importMapping: () => import("./toml.ts"),
    },
    {
        mimetype: "text/x-odin",
        glyph: "🪶",
        extensions: [".odin"],
        slug: "odin",
        wasmPackage: "tree-sitter-odin",
        wasmFile: "tree-sitter-odin.wasm",
        importMapping: () => import("./odin.ts"),
    },
    {
        mimetype: "text/css",
        glyph: "🎨",
        extensions: [".css"],
        slug: "css",
        wasmPackage: null,
        wasmFile: null,
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
