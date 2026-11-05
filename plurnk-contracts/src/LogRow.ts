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
 * {§turn-source-resources} {§db-migrations} Closed union of `log_entries.attrs` `kind` discriminator values.
 */
export const LOG_ENTRY_KINDS = Object.freeze([
    "emission",
    "reasoning",
    "message",
    "loop_termination",
    "entry_materialized",
    "emissionAttempt",
] as const);

export type LogEntryKind = (typeof LOG_ENTRY_KINDS)[number];

export const isLogEntryKind = (value: unknown): value is LogEntryKind =>
    typeof value === "string" && (LOG_ENTRY_KINDS as readonly string[]).includes(value);

/**
 * {§acp-plurnk-metadata} {§capability-policy-cascade} Canonical tool-call kind classification for a log or proposal operation.
 */
export const toolKindOf = (op: string | null, scheme: string | null): ProposalToolKind => {
    switch (op) {
        case "read":
            return scheme === "http" || scheme === "https" ? "fetch" : "read";
        case "edit":
        case "copy":
            return "edit";
        case "move":
            return "move";
        case "kill":
            return "delete";
        case "find":
            return "search";
        case "note":
        case "todo":
        case "wait":
            return "think";
        case "send":
        case "done":
        case "fail":
            return "other";
        case "work":
        case "fork":
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
