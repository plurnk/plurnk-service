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
