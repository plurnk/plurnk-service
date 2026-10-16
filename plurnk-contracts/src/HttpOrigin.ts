/**
 * {§http-request-origin} A request as far as its headers, which is all an origin is read from. A Node request
 * satisfies it, and naming it keeps the package root runtime-neutral ({§runtime-neutral-root}).
 */
export interface RequestHeaders {
    readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
}

/**
 * {§http-request-origin} The origin a request reached this daemon at: the address its `Host` names,
 * over http, or the listener's own for a request that names none.
 */
export const requestOrigin = (req: RequestHeaders, listener: { readonly host: string; readonly port: number }): string => {
    const named = req.headers.host;
    if (typeof named === "string" && named.length > 0) {
        try { return `http://${new URL(`http://${named}`).host}`; } catch { /* a Host that is no address names nothing */ }
    }
    return `http://${listener.host.includes(":") ? `[${listener.host}]` : listener.host}:${listener.port}`;
};
