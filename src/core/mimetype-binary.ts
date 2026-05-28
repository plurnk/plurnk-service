// Mimetype classifiers used at op-handler boundaries.
//
// `isBinaryMimetype` — enforces 415 on binary entries for READ/EDIT/
// SHOW/HIDE (AGENTS.md "Resolved ambiguities" §2).
//
// `isLineNavigableMimetype` — decides whether the render layer prefixes
// each line with `N:\t` on READ output. Line-oriented mimetypes (text,
// markdown, source code, line-aligned configs) get `N:\t`. Tree-oriented
// mimetypes (JSON, XML, HTML) don't — line numbers would conflict with
// the structural navigation those formats use (jsonpath, xpath).
//
// Local heuristic until @plurnk/plurnk-mimetypes exposes per-mimetype
// metadata via its public API (HandlerInfo flags exist at registry
// level; not queryable per-mimetype yet — see plurnk-mimetypes#3).

const TEXT_APPLICATION_MIMETYPES: ReadonlySet<string> = new Set([
    "application/json",
    "application/yaml",
    "application/toml",
    "application/xml",
    "application/javascript",
    "application/typescript",
    "application/sql",
]);

// Mimetypes that are structurally tree-navigated rather than line-
// navigated. READ output of these doesn't get `N:\t` prefixes.
const TREE_NAVIGABLE_MIMETYPES: ReadonlySet<string> = new Set([
    "application/json",
    "application/xml",
    "text/html",
]);

export const isBinaryMimetype = (mimetype: string): boolean => {
    if (mimetype.length === 0) return false;
    const slash = mimetype.indexOf("/");
    if (slash === -1) return true;
    const type = mimetype.slice(0, slash);
    if (type === "text") return false;
    if (TEXT_APPLICATION_MIMETYPES.has(mimetype)) return false;
    if (mimetype.endsWith("+json") || mimetype.endsWith("+xml") || mimetype.endsWith("+yaml")) return false;
    return true;
};

// JSON-family check — used by `<L>` dispatch to pick structural slicer
// (sliceJsonItems) over line slicer (sliceLines) for JSON sources.
// Matches application/json plus +json suffix variants per RFC 6839.
export const isJsonMimetype = (mimetype: string): boolean =>
    mimetype === "application/json" || mimetype.endsWith("+json");

export const isLineNavigableMimetype = (mimetype: string): boolean => {
    if (mimetype.length === 0) return false;
    if (isBinaryMimetype(mimetype)) return false;
    if (TREE_NAVIGABLE_MIMETYPES.has(mimetype)) return false;
    if (mimetype.endsWith("+json") || mimetype.endsWith("+xml")) return false;
    // Everything text-ish that isn't tree-shaped is line-navigable.
    // text/plain, text/markdown, text/csv, text/javascript, text/typescript,
    // application/yaml, application/toml, application/javascript, etc.
    return true;
};

// Text primitive for the agent contract: text/markdown is the default
// text mimetype anywhere plurnk-service auto-derives a text result.
// text/plain is reserved for explicit scheme-manifest declarations
// (exec subprocess streams) and client-set entries. Rationale: markdown
// is a strict superset of plain text — any plain text is valid markdown
// — so the agent gets markdown-aware processing capability for free,
// and never needs to decide "is this markdown enough to mark as
// markdown?"
//
// Use this at any consumer-side auto-derivation point (file scheme
// extension fallback, log rx wrap, etc.) to normalize text/plain → text/markdown.
export const TEXT_PRIMITIVE_MIMETYPE = "text/markdown";

export const normalizeAutoTextMimetype = (mimetype: string | null | undefined): string => {
    if (mimetype === null || mimetype === undefined || mimetype === "" || mimetype === "text/plain") {
        return TEXT_PRIMITIVE_MIMETYPE;
    }
    return mimetype;
};
