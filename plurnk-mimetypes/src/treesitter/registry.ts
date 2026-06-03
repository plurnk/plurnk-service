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
     * npm package name that ships the WASM grammar file. The framework
     * resolves `require.resolve` against this to locate the .wasm at runtime.
     * Consumers must install the package themselves (peer dep semantics —
     * we don't pull in every grammar by default).
     */
    readonly wasmPackage: string;
    /**
     * Relative path inside `wasmPackage` to the .wasm file. The standard
     * tree-sitter convention is `<pkg>/<pkg-without-prefix>.wasm` (e.g.
     * `tree-sitter-python/tree-sitter-python.wasm`).
     */
    readonly wasmFile: string;
    /**
     * Dynamic-import factory for the mapping module. The module must
     * export `extract(root, content)` returning MimeSymbol[].
     */
    readonly importMapping: () => Promise<TreeSitterLanguageMapping>;
}

export interface TreeSitterLanguageMapping {
    extract(root: TreeSitterNode, content: string): MimeSymbol[];
}

// Built-in tree-sitter language registry. Order is not significant; lookup
// is by mimetype. Add entries here when porting a new language; the mapping
// file lives at `src/treesitter/<short-name>.ts`.
export const TREE_SITTER_REGISTRY: readonly TreeSitterLanguageEntry[] = [
    {
        mimetype: "text/x-python",
        glyph: "🐍",
        extensions: [".py", ".pyw"],
        wasmPackage: "tree-sitter-python",
        wasmFile: "tree-sitter-python.wasm",
        importMapping: () => import("./python.ts"),
    },
    {
        mimetype: "text/x-haskell",
        glyph: "λ",
        extensions: [".hs", ".lhs"],
        wasmPackage: "tree-sitter-haskell",
        wasmFile: "tree-sitter-haskell.wasm",
        importMapping: () => import("./haskell.ts"),
    },
    {
        mimetype: "text/x-ruby",
        glyph: "💎",
        extensions: [".rb", ".rake", ".gemspec", "Rakefile", "Gemfile"],
        wasmPackage: "tree-sitter-ruby",
        wasmFile: "tree-sitter-ruby.wasm",
        importMapping: () => import("./ruby.ts"),
    },
    {
        mimetype: "text/x-shellscript",
        glyph: "🐚",
        extensions: [".sh", ".bash", ".zsh", ".bashrc", ".zshrc"],
        wasmPackage: "tree-sitter-bash",
        wasmFile: "tree-sitter-bash.wasm",
        importMapping: () => import("./bash.ts"),
    },
    {
        mimetype: "text/x-ocaml",
        glyph: "🐫",
        extensions: [".ml", ".mli"],
        wasmPackage: "tree-sitter-ocaml",
        wasmFile: "tree-sitter-ocaml.wasm",
        importMapping: () => import("./ocaml.ts"),
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

// Look up a registry entry by extension or special-filename. Used by
// detection. Returns null if no entry claims the extension.
export function lookupTreeSitterByExtension(ext: string): TreeSitterLanguageEntry | null {
    const lowered = ext.toLowerCase();
    for (const entry of TREE_SITTER_REGISTRY) {
        for (const e of entry.extensions) {
            if (e === lowered) return entry;
            // Special-filename match (Dockerfile, Makefile, CMakeLists.txt) —
            // case-sensitive verbatim, no leading dot.
            if (!e.startsWith(".") && e === ext) return entry;
        }
    }
    return null;
}
