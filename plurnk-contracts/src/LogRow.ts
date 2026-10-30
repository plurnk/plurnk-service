import type { ProposalProjection } from "./types.generated.ts";

export type LogAddressColumns = {
    scheme: string | null;
    username: string | null;
    password: string | null;
    hostname: string | null;
    port: number | null;
    pathname: string | null;
    query: string | null;
    fragment: string | null;
};

export type ProposalToolKind = Extract<NonNullable<ProposalProjection["subject"]>, { type: "tool_call" }>["kind"];

/**
 * {§acp-plurnk-metadata} {§capability-policy-cascade} Canonical tool-call kind classification for a log or proposal operation.
 */
export const toolKindOf = (op: string | null, scheme: string | null): ProposalToolKind => {
    switch (op) {
        case "READ":
            return scheme === "http" || scheme === "https" ? "fetch" : "read";
        case "EDIT":
        case "COPY":
            return "edit";
        case "MOVE":
            return "move";
        case "KILL":
            return "delete";
        case "FIND":
            return "search";
        case "NOTE":
        case "WAIT":
            return "think";
        case "SEND":
            return "other";
        case "WORK":
        case "FORK":
            return "execute";
        default:
            return op === null ? "other" : "execute";
    }
};

/**
 * {§acp-plurnk-metadata} The address a row recorded: `scheme://host[:port]path[?query][#fragment]`, or the bare path a
 * file target records, with its channel; null when the row named none.
 */
export const addressOf = (row: {
    readonly scheme?: unknown;
    readonly hostname?: unknown;
    readonly port?: unknown;
    readonly pathname?: unknown;
    readonly query?: unknown;
    readonly fragment?: unknown;
}): string | null => {
    const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
    const pathname = text(row.pathname);
    if (pathname === null) return null;
    const fragment = text(row.fragment) === null ? "" : `#${text(row.fragment)}`;
    const scheme = text(row.scheme);
    if (scheme === null) return `${pathname}${fragment}`;
    const port = typeof row.port === "number" ? `:${row.port}` : "";
    const query = text(row.query) === null ? "" : `?${text(row.query)}`;
    return `${scheme}://${text(row.hostname) ?? ""}${port}${pathname}${query}${fragment}`;
};
