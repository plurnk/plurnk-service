// Deterministic in-memory tracing for the observational-boundary tests
// ({§observability-boundary}). Each test file runs in its own process, so the
// global provider registration stays isolated to this file's specimens.

import { context, trace } from "@opentelemetry/api";
import { AsyncHooksContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan } from "@opentelemetry/sdk-trace-base";

export interface MemoryTracing {
    spans(): ReadableSpan[];
    shutdown(): Promise<void>;
}

export const mountMemoryTracing = async (): Promise<MemoryTracing> => {
    // The SDK initializes the async-hooks context manager at start();
    // the deterministic mount must mirror it or context never crosses `await`.
    const contextManager = new AsyncHooksContextManager();
    contextManager.enable();
    context.setGlobalContextManager(contextManager);
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    trace.setGlobalTracerProvider(provider);
    return {
        spans: (): ReadableSpan[] => exporter.getFinishedSpans(),
        shutdown: async (): Promise<void> => {
            await provider.shutdown();
            contextManager.disable();
        },
    };
};
