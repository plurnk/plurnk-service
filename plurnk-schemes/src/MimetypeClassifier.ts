// Mimetype classifiers used at op-handler boundaries.
//
// `isBinaryMimetype` — enforces 415 on binary entries for READ/EDIT/
// SHOW/HIDE (SPEC.md §16.9 — binary entries → 415).
//
// `isLineNavigableMimetype` — decides whether the render layer prefixes
// each line with `N:\t` on READ output. Line-oriented mimetypes (text,
// markdown, source code, line-aligned configs) get `N:\t`. Tree-oriented
// mimetypes (JSON, XML, HTML) don't — line numbers would conflict with
// the structural navigation those formats use (jsonpath, xpath).
//
// Local heuristic until @plurnk/plurnk-mimetypes exposes per-mimetype
// binary/text + line-navigable classification via its public API — at which
// point these tables retire and this delegates upstream. Requested in
// plurnk-mimetypes#43 (HandlerInfo flags exist at registry level but aren't
// queryable per-mimetype yet). The NDJSON drift (schemes#28) is the motivation.

const TEXT_APPLICATION_MIMETYPES: ReadonlySet<string> = new Set([
    "application/json",
    "application/yaml",
    "application/toml",
    "application/xml",
    "application/javascript",
    "application/typescript",
    "application/sql",
    // NDJSON family — line-delimited JSON. Text, and MORE line-navigable than a
    // single JSON doc (each line is a record); the `jsonl` suffix isn't `+json`,
    // so without an explicit entry it falls through to binary → 415 on READ
    // (schemes#28; surfaced via EXEC[jq] streams labelled application/jsonl).
    "application/jsonl",
    "application/x-ndjson",
]);

// Mimetypes that are structurally tree-navigated rather than line-
// navigated. READ output of these doesn't get `N:\t` prefixes.
const TREE_NAVIGABLE_MIMETYPES: ReadonlySet<string> = new Set([
    "application/json",
    "application/xml",
    "text/html",
]);

// Text primitive for the agent contract: text/markdown is the default
// text mimetype anywhere plurnk-service auto-derives a text result.
// text/plain is reserved for explicit scheme-manifest declarations
// (exec subprocess streams) and client-set entries. Rationale: markdown
// is a strict superset of plain text — any plain text is valid markdown
// — so the agent gets markdown-aware processing capability for free,
// and never needs to decide "is this markdown enough to mark as
// markdown?"
export const TEXT_PRIMITIVE_MIMETYPE = "text/markdown";

export default class MimetypeClassifier {
    static isBinary(mimetype: string): boolean {
        if (mimetype.length === 0) return false;
        const slash = mimetype.indexOf("/");
        if (slash === -1) return true;
        const type = mimetype.slice(0, slash);
        if (type === "text") return false;
        if (TEXT_APPLICATION_MIMETYPES.has(mimetype)) return false;
        if (mimetype.endsWith("+json") || mimetype.endsWith("+xml") || mimetype.endsWith("+yaml")) return false;
        return true;
    }

    // JSON-family check — used by `<L>` dispatch to pick structural slicer
    // (Slicer.jsonItems) over line slicer (Slicer.lines) for JSON sources.
    // Matches application/json plus +json suffix variants per RFC 6839.
    static isJson(mimetype: string): boolean {
        return mimetype === "application/json" || mimetype.endsWith("+json");
    }

    static isLineNavigable(mimetype: string): boolean {
        if (mimetype.length === 0) return false;
        if (MimetypeClassifier.isBinary(mimetype)) return false;
        if (TREE_NAVIGABLE_MIMETYPES.has(mimetype)) return false;
        if (mimetype.endsWith("+json") || mimetype.endsWith("+xml")) return false;
        // Everything text-ish that isn't tree-shaped is line-navigable.
        // text/plain, text/markdown, text/csv, text/javascript, text/typescript,
        // application/yaml, application/toml, application/javascript, etc.
        return true;
    }

    // Normalize an auto-derived text mimetype to the text primitive.
    // Use at any consumer-side auto-derivation point (file scheme
    // extension fallback, log rx wrap, etc.): text/plain / null / undefined
    // / empty → text/markdown.
    static normalizeAutoText(mimetype: string | null | undefined): string {
        if (mimetype === null || mimetype === undefined || mimetype === "" || mimetype === "text/plain") {
            return TEXT_PRIMITIVE_MIMETYPE;
        }
        return mimetype;
    }
}
