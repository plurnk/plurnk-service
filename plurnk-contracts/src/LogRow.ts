// {§acp-plurnk-metadata} A row's attributes that hold a body: a file write's text before and after, its diff and its edit
// receipt, which its result holds, and a statement's body, which its call's arguments hold.
const BODY_ATTRS: ReadonlySet<string> = new Set([
    "original",
    "patched",
    "patchedBytes",
    "patch",
    "editReceipt",
    "body",
    "inputBody",
]);

/** {§acp-plurnk-metadata} A row's attributes without the bodies they hold, on every part and projection that carries them. */
export const withoutBodies = (attrs: Readonly<Record<string, unknown>>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(attrs).filter(([key]) => !BODY_ATTRS.has(key)));

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
