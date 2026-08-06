// The AG-UI observational boundary ({§observability-boundary}). This package
// depends only on the OTel API; the daemon initializes any SDK. Default state is
// the no-op API. Attributes carry identifiers/statuses only — prompts, payloads,
// and arbitrary URLs never enter spans here.

import { context, SpanStatusCode, trace, type Span } from "@opentelemetry/api";

export const TRACER_NAME = "plurnk.agui";

export const aguiTracer = (): ReturnType<typeof trace.getTracer> => trace.getTracer(TRACER_NAME);

const MAX_STRING_LENGTH = 300;

const sanitize = (attributes: Record<string, unknown>): Record<string, string | number | boolean> => {
    const out: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(attributes)) {
        if (value === undefined) continue;
        if (typeof value === "string") {
            out[key] = value.length <= MAX_STRING_LENGTH ? value : value.slice(0, MAX_STRING_LENGTH);
        } else if (typeof value === "number" || typeof value === "boolean") {
            out[key] = value;
        }
    }
    return out;
};

export const observed = async <T>(
    name: string,
    attributes: Record<string, unknown>,
    fn: (span: Span) => Promise<T>,
): Promise<T> => {
    const span = aguiTracer().startSpan(name, { attributes: sanitize(attributes) });
    try {
        return await context.with(trace.setSpan(context.active(), span), () => fn(span));
    } catch (err) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw err;
    } finally {
        span.end();
    }
};

export const observedSync = <T>(
    name: string,
    attributes: Record<string, unknown>,
    fn: () => T,
): T => {
    const span = aguiTracer().startSpan(name, { attributes: sanitize(attributes) });
    try {
        return fn();
    } catch (err) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw err;
    } finally {
        span.end();
    }
};
