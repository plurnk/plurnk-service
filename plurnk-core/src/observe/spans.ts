// Redaction-first span helpers for the observational boundary
// ({§observability-boundary}). Instrumentation sites pass identifiers, counts,
// and statuses only; prompts, reasoning, file bodies, arbitrary URLs, secrets,
// and plugin payloads never reach attributes here. String attribute values are
// length-capped as a backstop so an oversized or hostile value cannot leak
// through a span. Failure marks the span ERROR without recording the error
// message, which could embed excluded content.

import {
    context,
    SpanStatusCode,
    trace,
    type Span,
    type SpanKind,
    type SpanOptions,
} from "@opentelemetry/api";
import { serviceTracer } from "./api.ts";

const MAX_STRING_LENGTH = 300;

const errorType = (error: unknown): string => {
    const name = error instanceof Error ? error.constructor.name : typeof error;
    return name.length <= MAX_STRING_LENGTH ? name : name.slice(0, MAX_STRING_LENGTH);
};

const spanOptions = (
    attributes: Record<string, unknown>,
    options?: SpanOptions,
): SpanOptions => ({
    ...options,
    attributes: {
        ...sanitize(attributes),
        ...(options?.attributes === undefined ? {} : sanitize(options.attributes as Record<string, unknown>)),
    },
});

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
    options?: SpanOptions,
): Promise<T> => {
    const span = serviceTracer().startSpan(name, spanOptions(attributes, options));
    try {
        return await context.with(trace.setSpan(context.active(), span), () => fn(span));
    } catch (err) {
        // {§observability-genai-conventions} — error.type carries only the
        // class name, never the message ({§observability-boundary}).
        span.setAttribute("error.type", errorType(err));
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw err;
    } finally {
        span.end();
    }
};

export const observedSync = <T>(
    name: string,
    attributes: Record<string, unknown>,
    fn: (span: Span) => T,
    options?: SpanOptions,
): T => {
    const span = serviceTracer().startSpan(name, spanOptions(attributes, options));
    try {
        return fn(span);
    } catch (err) {
        span.setAttribute("error.type", errorType(err));
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw err;
    } finally {
        span.end();
    }
};
