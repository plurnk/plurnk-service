// Deterministic in-memory tracing for the observational-boundary tests
// ({§observability-boundary}). Each test file runs in its own process, so the
// global provider registration stays isolated to this file's specimens.

import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { TracerProvider, InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan, type SpanProcessor } from "@opentelemetry/sdk-trace";

export interface MemoryTracing {
    spans(): ReadableSpan[];
    shutdown(): Promise<void>;
}

export const mountMemoryTracing = async (onStart?: SpanProcessor["onStart"]): Promise<MemoryTracing> => {
    // The SDK installs its context manager at start();
    // the deterministic mount must mirror it or context never crosses `await`.
    trace.disable();
    context.disable();
    const contextManager = new AsyncLocalStorageContextManager();
    contextManager.enable();
    context.setGlobalContextManager(contextManager);
    const exporter = new InMemorySpanExporter();
    const processor = new SimpleSpanProcessor({ exporter });
    if (onStart !== undefined) processor.onStart = onStart;
    const provider = new TracerProvider({ spanProcessors: [processor] });
    trace.setGlobalTracerProvider(provider);
    return {
        spans: (): ReadableSpan[] => exporter.getFinishedSpans(),
        shutdown: async (): Promise<void> => {
            await provider.shutdown();
            contextManager.disable();
            trace.disable();
            context.disable();
        },
    };
};
