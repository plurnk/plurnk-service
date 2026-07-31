// Per-mimetype classification (SPEC §20, #43): this family is the single
// source of binary-vs-text truth, so consumers stop hand-maintaining allowlists
// that drift (the application/jsonl -> 415 bug, schemes#28).
//
// Two layers:
//   * classifyMimetype() - the pure taxonomy heuristic (this file): sync, no
//     registry, answers for any mimetype string - consumers classify stream
//     labels for types with no installed handler (image/png on a byte stream).
//     Rules are RFC-shaped (type prefix, RFC 6839 structured-syntax suffixes)
//     plus the known text-application set.
//   * Mimetypes.classify() - registry-aware: an installed handler's declared
//     plurnk.binary value overrides the heuristic.

export interface MimeClassification {
    binary: boolean;
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

// RFC 6839 structured-syntax suffixes that mark a type as text.
const TEXT_SUFFIXES = ["+json", "+xml", "+yaml", "+toml"];

// The pure taxonomy heuristic. Answers for ANY mimetype string; installed
// handlers refine it via Mimetypes.classify(). Edge semantics (absorbed from
// the consumer contract): "" is not binary; a slash-less string is malformed
// and therefore binary (consumers 415).
export function classifyMimetype(mimetype: string): MimeClassification {
    return {
        binary: isBinaryHeuristic(mimetype),
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

// Registry-aware refinement, called by Mimetypes.classify() with the installed
// handler's declared facts. Declared binary is authoritative.
export function classifyWithHandler(
    _mimetype: string,
    declared: { binary: boolean },
): MimeClassification {
    return { binary: declared.binary, source: "handler" };
}
