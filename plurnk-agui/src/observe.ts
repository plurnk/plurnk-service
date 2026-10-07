// The AG-UI observational boundary ({§observability-boundary}). This package
// depends only on the OTel API; the daemon initializes any SDK. Default state is
// the no-op API. Attributes carry identifiers/statuses only — prompts, payloads,
// and arbitrary URLs never enter spans here. The redaction-first helpers are the
// shared ones ({§observed-span}), bound to this module's tracer.

import { trace, type Span } from "@opentelemetry/api";
import { observed as observedWith, observedSync as observedSyncWith } from "@plurnk/plurnk-meta";

const TRACER_NAME = "plurnk.agui";

const aguiTracer = (): ReturnType<typeof trace.getTracer> => trace.getTracer(TRACER_NAME);

export type AguiRouteTemplate = "/agui" | "preflight" | "unmatched";

export const aguiRouteTemplate = (
    method: string | undefined,
    url: string | undefined,
): AguiRouteTemplate => {
    if (method === "OPTIONS") return "preflight";
    if (method === "POST" && url === "/agui") return "/agui";
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
