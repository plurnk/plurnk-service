import { context, SpanStatusCode, trace, type Span, type SpanOptions, type Tracer } from "@opentelemetry/api";

// {§observed-span} — redaction-first span helpers shared by every instrumented package. Callers
// pass identifiers, counts and statuses only; string values are length-capped as a backstop, and a
// failure marks the span ERROR with the error's class name, never its message.

const MAX_STRING_LENGTH = 300;

const errorType = (error: unknown): string => {
    const name = error instanceof Error ? error.constructor.name : typeof error;
    return name.length <= MAX_STRING_LENGTH ? name : name.slice(0, MAX_STRING_LENGTH);
};

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

const spanOptions = (attributes: Record<string, unknown>, options?: SpanOptions): SpanOptions => ({
    ...options,
    attributes: {
        ...sanitize(attributes),
        ...(options?.attributes === undefined ? {} : sanitize(options.attributes as Record<string, unknown>)),
    },
});

const failed = (span: Span, error: unknown): void => {
    span.setAttribute("error.type", errorType(error));
    span.setStatus({ code: SpanStatusCode.ERROR });
};

export const observed = async <T>(
    tracer: Tracer,
    name: string,
    attributes: Record<string, unknown>,
    fn: (span: Span) => Promise<T>,
    options?: SpanOptions,
): Promise<T> => {
    const span = tracer.startSpan(name, spanOptions(attributes, options));
    try {
        return await context.with(trace.setSpan(context.active(), span), () => fn(span));
    } catch (error) {
        failed(span, error);
        throw error;
    } finally {
        span.end();
    }
};

export const observedSync = <T>(
    tracer: Tracer,
    name: string,
    attributes: Record<string, unknown>,
    fn: (span: Span) => T,
    options?: SpanOptions,
): T => {
    const span = tracer.startSpan(name, spanOptions(attributes, options));
    try {
        return fn(span);
    } catch (error) {
        failed(span, error);
        throw error;
    } finally {
        span.end();
    }
};
