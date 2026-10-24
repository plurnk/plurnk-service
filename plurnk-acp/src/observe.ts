// The ACP observational boundary ({§observability-boundary}). This package
// depends only on the OTel API; the daemon initializes any SDK. Default state is
// the no-op API. Attributes carry identifiers/statuses only — prompts, payloads,
// and arbitrary URLs never enter spans here. The redaction-first helpers are the
// shared ones ({§observed-span}), bound to this module's tracer.

import { trace, type Span } from "@opentelemetry/api";
import { observed as observedWith, observedSync as observedSyncWith } from "@plurnk/plurnk-meta";

const TRACER_NAME = "plurnk.acp";

const acpTracer = (): ReturnType<typeof trace.getTracer> => trace.getTracer(TRACER_NAME);

export type AcpRouteTemplate = "/acp" | "/acp/connect" | "/acp/entry" | "/acp/{workspace}/{worker}/entry" | "/acp/{workspace}/{worker}/messages"
    | "preflight" | "unmatched";

// {§acp-entry-route} An address at this daemon: workspace, the worker whose perspective reads it, then the address as a query.
export const ENTRY_ROUTE = /^\/acp\/(\d+)\/(\d+)\/entry(?:\?([^#]*))?$/u;

// {§acp-history-page} A worker's history pages at this daemon: workspace, worker, then the view and cursor as a query.
export const HISTORY_ROUTE = /^\/acp\/(\d+)\/(\d+)\/messages(?:\?([^#]*))?$/u;

export const acpRouteTemplate = (
    method: string | undefined,
    url: string | undefined,
): AcpRouteTemplate => {
    if (method === "OPTIONS") return "preflight";
    if (method === "POST" && url === "/acp") return "/acp";
    if (method === "POST" && url === "/acp/connect") return "/acp/connect";
    if (method === "GET" && url !== undefined && (url === "/acp/entry" || url.startsWith("/acp/entry?"))) return "/acp/entry";
    if (method === "GET" && url !== undefined && ENTRY_ROUTE.test(url)) return "/acp/{workspace}/{worker}/entry";
    if (method === "GET" && url !== undefined && HISTORY_ROUTE.test(url)) return "/acp/{workspace}/{worker}/messages";
    return "unmatched";
};

export const observed = <T>(
    name: string,
    attributes: Record<string, unknown>,
    fn: (span: Span) => Promise<T>,
): Promise<T> => observedWith(acpTracer(), name, attributes, fn);

export const observedSync = <T>(
    name: string,
    attributes: Record<string, unknown>,
    fn: () => T,
): T => observedSyncWith(acpTracer(), name, attributes, fn);
