// The daemon-owned OTel SDK boundary ({§observability-boundary}). This is the
// only module that constructs the SDK; reusable packages acquire tracers and
// meters through api.ts. Behavior rules:
//
// - Standard OTEL_* env config: OTEL_TRACES_EXPORTER / OTEL_METRICS_EXPORTER
//   (otlp | console), OTEL_SERVICE_NAME, OTEL_SDK_DISABLED, and the OTLP
//   exporter's own OTEL_EXPORTER_OTLP_* settings.
// - Unconfigured processes never load the SDK: no exporter named (and not
//   disabled) returns null and the API stays no-op.
// - Every signal is explicit: an exporter list is passed for every source, so
//   the SDK's own "empty → default otlp" fallback can never fire. A signal with
//   no exporter is registered with an empty processor/reader list (off).
// - OTel Logs are excluded by contract: the logger provider is given an empty
//   processor list instead of the env-driven default.
// - Unknown exporter names fail at boot; a typo must not silently disable the
//   operator's configured observation.
// - One SDK per process, first initialization wins; its shutdown is owned by
//   the daemon teardown.

import type { NodeSDK } from "@opentelemetry/sdk-node";
import {
    BatchSpanProcessor,
    ConsoleSpanExporter,
    SimpleSpanProcessor,
    type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
    ConsoleMetricExporter,
    PeriodicExportingMetricReader,
    type MetricReader,
} from "@opentelemetry/sdk-metrics";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";

export interface ObservabilityHandle {
    shutdown(): Promise<void>;
}

const SERVICE_NAME = "plurnk-service";

type Env = Record<string, string | undefined>;

const exporterNames = (value: string | undefined): string[] =>
    [...new Set((value ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0))];

const enabledNames = (value: string | undefined): string[] =>
    exporterNames(value).filter((name) => name !== "none");

const traceProcessors = (names: string[]): SpanProcessor[] => names.map((name) => {
    switch (name) {
        case "otlp": return new BatchSpanProcessor(new OTLPTraceExporter());
        case "console": return new SimpleSpanProcessor(new ConsoleSpanExporter());
        default:
            throw new Error(
                `observe: unsupported OTEL_TRACES_EXPORTER value ${JSON.stringify(name)} (supported: otlp, console)`,
            );
    }
});

const metricReaders = (names: string[]): MetricReader[] => names.map((name) => {
    switch (name) {
        case "otlp": return new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter() });
        case "console": return new PeriodicExportingMetricReader({ exporter: new ConsoleMetricExporter() });
        default:
            throw new Error(
                `observe: unsupported OTEL_METRICS_EXPORTER value ${JSON.stringify(name)} (supported: otlp, console)`,
            );
    }
});

let active: ObservabilityHandle | null = null;

export const startObservability = async (env: Env = process.env): Promise<ObservabilityHandle | null> => {
    if (active !== null) return active;
    if (env.OTEL_SDK_DISABLED === "true") return null;
    const traces = enabledNames(env.OTEL_TRACES_EXPORTER);
    const metrics = enabledNames(env.OTEL_METRICS_EXPORTER);
    if (traces.length === 0 && metrics.length === 0) return null;

    const { NodeSDK: NodeSdk } = await import("@opentelemetry/sdk-node");
    const sdk: NodeSDK = new NodeSdk({
        instrumentations: [], // hand-instrumented boundaries only; no auto-patching
        serviceName: env.OTEL_SERVICE_NAME ?? SERVICE_NAME,
        spanProcessors: traceProcessors(traces),
        metricReaders: metricReaders(metrics),
        logRecordProcessors: [], // OTel Logs excluded by contract
    });
    await sdk.start();
    const handle: ObservabilityHandle = {
        // One SDK per process, first initialization wins. The handle drops out of
        // the cache on shutdown so a later daemon in the same process can re-init.
        shutdown: async () => {
            if (active === null) return;
            active = null;
            await sdk.shutdown();
        },
    };
    active = handle;
    return handle;
};
