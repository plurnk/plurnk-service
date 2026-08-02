// Pure registry-free half of {§mimetype-classification}; Mimetypes.classify()
// applies installed handler declarations first.

export interface MimeClassification {
    binary: boolean;
    // Authority that decided the value.
    source: "handler" | "heuristic";
}

// Textual application types without a sufficient structured suffix.
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

// Answers without registry state; installed handlers refine this result.
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

// Installed declaration refinement.
export function classifyWithHandler(
    _mimetype: string,
    declared: { binary: boolean },
): MimeClassification {
    return { binary: declared.binary, source: "handler" };
}
