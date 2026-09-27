// The service's binding of the shared redaction-first span helpers ({§observed-span}) to its own
// tracer, inside the observational boundary ({§observability-boundary}).

import type { Span, SpanOptions } from "@opentelemetry/api";
import { observed as observedWith, observedSync as observedSyncWith } from "@plurnk/plurnk-meta";
import { serviceTracer } from "./api.ts";

export const observed = <T>(
    name: string,
    attributes: Record<string, unknown>,
    fn: (span: Span) => Promise<T>,
    options?: SpanOptions,
): Promise<T> => observedWith(serviceTracer(), name, attributes, fn, options);

export const observedSync = <T>(
    name: string,
    attributes: Record<string, unknown>,
    fn: (span: Span) => T,
    options?: SpanOptions,
): T => observedSyncWith(serviceTracer(), name, attributes, fn, options);
