import type { IncomingMessage } from "node:http";

/**
 * {§http-request-origin} The origin a request reached this daemon at: the address its `Host` names,
 * over http, or the listener's own for a request that names none.
 */
export const requestOrigin = (req: Pick<IncomingMessage, "headers">, listener: { readonly host: string; readonly port: number }): string => {
    const named = req.headers.host;
    if (named !== undefined && named.length > 0) {
        try { return `http://${new URL(`http://${named}`).host}`; } catch { /* a Host that is no address names nothing */ }
    }
    return `http://${listener.host.includes(":") ? `[${listener.host}]` : listener.host}:${listener.port}`;
};
