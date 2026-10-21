// The AG-UI observational boundary ({§observability-boundary}). This package
// depends only on the OTel API; the daemon initializes any SDK. Default state is
// the no-op API. Attributes carry identifiers/statuses only — prompts, payloads,
// and arbitrary URLs never enter spans here. The redaction-first helpers are the
// shared ones ({§observed-span}), bound to this module's tracer.

import { trace, type Span } from "@opentelemetry/api";
import { observed as observedWith, observedSync as observedSyncWith } from "@plurnk/plurnk-meta";

const TRACER_NAME = "plurnk.agui";

const aguiTracer = (): ReturnType<typeof trace.getTracer> => trace.getTracer(TRACER_NAME);

export type AguiRouteTemplate = "/agui" | "/agui/connect" | "/agui/{workspace}/{worker}/log/{loop}/{turn}/{sequence}/{op}"
    | "/agui/{workspace}/{worker}/reasoning/{loop}/{turn}" | "/agui/{workspace}/{worker}/messages" | "preflight" | "unmatched";

// {§agui-body-reference} A row's body at this daemon: workspace, worker, then the row's log address `L/T/S/OP`.
export const BODY_ROUTE = /^\/agui\/(\d+)\/(\d+)\/log\/(\d+)\/(\d+)\/(\d+)\/([^/?#]+)$/u;

// {§agui-body-reference} A turn's reasoning at this daemon: workspace, worker, then the turn's address `L/T`.
export const REASONING_ROUTE = /^\/agui\/(\d+)\/(\d+)\/reasoning\/(\d+)\/(\d+)$/u;

// {§agui-history-page} A worker's history pages at this daemon: workspace, worker, then the view and cursor as a query.
export const HISTORY_ROUTE = /^\/agui\/(\d+)\/(\d+)\/messages(?:\?([^#]*))?$/u;

export const aguiRouteTemplate = (
    method: string | undefined,
    url: string | undefined,
): AguiRouteTemplate => {
    if (method === "OPTIONS") return "preflight";
    if (method === "POST" && url === "/agui") return "/agui";
    if (method === "POST" && url === "/agui/connect") return "/agui/connect";
    if (method === "GET" && url !== undefined && BODY_ROUTE.test(url)) return "/agui/{workspace}/{worker}/log/{loop}/{turn}/{sequence}/{op}";
    if (method === "GET" && url !== undefined && REASONING_ROUTE.test(url)) return "/agui/{workspace}/{worker}/reasoning/{loop}/{turn}";
    if (method === "GET" && url !== undefined && HISTORY_ROUTE.test(url)) return "/agui/{workspace}/{worker}/messages";
    return "unmatched";
};

export const observed = <T>(
    name: string,
    attributes: Record<string, unknown>,
    fn: (span: Span) => Promise<T>,
): Promise<T> => observedWith(aguiTracer(), name, attributes, fn);

export const observedSync = <T>(
    name: string,
    attributes: Record<string, unknown>,
    fn: () => T,
): T => observedSyncWith(aguiTracer(), name, attributes, fn);
