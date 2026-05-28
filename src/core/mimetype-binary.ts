// Is a mimetype line-oriented text, or binary bytes? Used by op handlers
// to enforce 415 on binary entries (per AGENTS.md "Contract gaps" §2:
// binary mimetypes return 415 for READ/EDIT/SHOW/HIDE across the board).
//
// Local heuristic until @plurnk/plurnk-mimetypes exposes per-mimetype
// `binary` metadata via its public API (HandlerInfo.binary exists at
// registry level; not queryable per-mimetype yet — see plurnk-mimetypes#3).

const TEXT_APPLICATION_MIMETYPES: ReadonlySet<string> = new Set([
    "application/json",
    "application/yaml",
    "application/toml",
    "application/xml",
    "application/javascript",
    "application/typescript",
    "application/sql",
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
