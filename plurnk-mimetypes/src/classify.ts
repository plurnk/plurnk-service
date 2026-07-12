// Per-mimetype classification (SPEC §20, #43): this family is the single
// source of filetype truth, so binary-vs-text and line-vs-tree navigation are
// answered HERE — consumers (plurnk-schemes' retired MimetypeClassifier) stop
// hand-maintaining allowlists that drift (the application/jsonl → 415 bug,
// schemes#28).
//
// Two layers:
//   * classifyMimetype() — the pure TAXONOMY heuristic (this file): sync, no
//     registry, answers for ANY mimetype string — consumers classify stream
//     labels for types with no installed handler (image/png on a byte stream).
//     Rules are RFC-shaped (type prefix, RFC 6839 structured-syntax suffixes)
//     plus the known text-application set.
//   * Mimetypes.classify() — registry-aware: an INSTALLED handler's declared
//     facts (plurnk.binary, plurnk.navigation) override the heuristic; absent
//     declarations fall through to it.

export interface MimeClassification {
    binary: boolean;
    // Line-navigable = the model addresses this content by line number (`N:\t`
    // READ prefixes, line-based <L>); tree-navigated = structural addressing
    // (jsonpath/xpath) where line prefixes would fight the format's own
    // navigation. The axes do NOT collapse: NDJSON is text AND line-navigable
    // (each line is a record); a single JSON doc is text and tree-navigated.
    lineNavigable: boolean;
    // Provenance: "handler" when an installed handler's declaration decided
    // (registry truth), "heuristic" when taxonomy rules did.
    source: "handler" | "heuristic";
}

// application/* types that are text despite the type prefix. The jsonl entries
// are the schemes#28 lesson: the `jsonl` suffix is not `+json`, so suffix rules
// alone misread NDJSON as binary.
const TEXT_APPLICATION = new Set([
    "application/json",
    "application/yaml",
    "application/toml",
    "application/xml",
    "application/javascript",
    "application/ecmascript",
    "application/typescript",
    "application/sql",
    "application/jsonl",
    "application/x-ndjson",
]);

// Tree-navigated types: JSON-shaped and markup documents whose native
// navigation is structural (jsonpath/xpath), not line numbers. yaml/toml/csv
// are deliberately NOT here — they are line-oriented text (a `N:\t` prefix
// reads naturally), matching the consumer semantics this absorbs.
const TREE_NAVIGATED = new Set([
    "application/json",
    "application/xml",
    "text/html",
]);

// RFC 6839 structured-syntax suffixes that mark a type as text.
const TEXT_SUFFIXES = ["+json", "+xml", "+yaml", "+toml"];
// Suffixes whose structure is tree-navigated.
const TREE_SUFFIXES = ["+json", "+xml"];

// The pure taxonomy heuristic. Answers for ANY mimetype string; installed
// handlers refine it via Mimetypes.classify(). Edge semantics (absorbed from
// the consumer contract): "" → not binary but not line-navigable (no type, no
// navigation); a slash-less string is malformed → binary (consumers 415).
export function classifyMimetype(mimetype: string): MimeClassification {
    const binary = isBinaryHeuristic(mimetype);
    return {
        binary,
        lineNavigable: mimetype.length > 0 && !binary && !isTreeNavigated(mimetype),
        source: "heuristic",
    };
}

function isBinaryHeuristic(mimetype: string): boolean {
    if (mimetype.length === 0) return false;
    const slash = mimetype.indexOf("/");
    if (slash === -1) return true;
    if (mimetype.slice(0, slash) === "text") return false;
    if (TEXT_APPLICATION.has(mimetype)) return false;
    return !TEXT_SUFFIXES.some((s) => mimetype.endsWith(s));
}

function isTreeNavigated(mimetype: string): boolean {
    return TREE_NAVIGATED.has(mimetype) || TREE_SUFFIXES.some((s) => mimetype.endsWith(s));
}

// Registry-aware refinement, called by Mimetypes.classify() with the installed
// handler's declared facts. Declared binary is authoritative (pdf declares
// binary:true); declared navigation ("line" | "tree") wins over the taxonomy;
// a binary type is never line-navigable regardless of declarations.
export function classifyWithHandler(
    mimetype: string,
    declared: { binary: boolean; navigation?: "line" | "tree" },
): MimeClassification {
    const heuristic = classifyMimetype(mimetype);
    const lineNavigable = declared.binary
        ? false
        : declared.navigation !== undefined
            ? declared.navigation === "line"
            : heuristic.lineNavigable;
    return { binary: declared.binary, lineNavigable, source: "handler" };
}
