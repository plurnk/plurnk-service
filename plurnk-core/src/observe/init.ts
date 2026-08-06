// The daemon-owned OTel implementation boundary ({§observability-boundary}).
// Configuration is normalized before any SDK/exporter module loads. Reusable
// modules depend only on the API; this owner registers only the selected trace
// and metric providers and has no Logs path.

import type {
    MeterProvider as ApiMeterProvider,
    TracerProvider as ApiTracerProvider,
} from "@opentelemetry/api";

export interface ObservabilityHandle {
    shutdown(): Promise<void>;
}

const SERVICE_NAME = "plurnk-service";

type Env = Record<string, string | undefined>;
type SignalName = "OTEL_TRACES_EXPORTER" | "OTEL_METRICS_EXPORTER";
type ExporterName = "otlp" | "console";
type ShutdownOwner = { shutdown(): Promise<void> };
type TraceProviderOwner = ApiTracerProvider & ShutdownOwner;
type MetricProviderOwner = ApiMeterProvider & ShutdownOwner;

interface Selection {
    readonly traces: ExporterName[];
    readonly metrics: ExporterName[];
    readonly serviceName: string;
}

const exporterNames = (value: string | undefined): string[] => [
    ...new Set((value ?? "")
        .split(",")
        .map((name) => name.trim().toLowerCase())
        .filter((name) => name.length > 0 && name !== "none")),
];

const selectExporters = (env: Env, signal: SignalName): ExporterName[] => exporterNames(env[signal]).map((name) => {
    if (name === "otlp" || name === "console") return name;
    throw new Error(
        `observe: unsupported ${signal} value ${JSON.stringify(name)} (supported: otlp, console)`,
    );
});

const select = (env: Env): Selection | null => {
    if (env.OTEL_SDK_DISABLED?.trim().toLowerCase() === "true") return null;
    const traces = selectExporters(env, "OTEL_TRACES_EXPORTER");
    const metrics = selectExporters(env, "OTEL_METRICS_EXPORTER");
    if (traces.length === 0 && metrics.length === 0) return null;
    const configuredServiceName = env.OTEL_SERVICE_NAME;
    return {
        traces,
        metrics,
        serviceName: configuredServiceName === undefined || configuredServiceName.trim() === ""
            ? SERVICE_NAME
            : configuredServiceName,
    };
};

let active: ObservabilityHandle | null = null;
let starting: Promise<ObservabilityHandle | null> | null = null;

const initialize = async (selection: Selection): Promise<ObservabilityHandle> => {
    const [{ context, metrics, trace }, { resourceFromAttributes }] = await Promise.all([
        import("@opentelemetry/api"),
        import("@opentelemetry/resources"),
    ]);
    const resource = resourceFromAttributes({ "service.name": selection.serviceName });
    let traceProvider: TraceProviderOwner | null = null;
    let metricProvider: MetricProviderOwner | null = null;
    let contextRegistered = false;
    let traceRegistered = false;
    let metricsRegistered = false;

    const shutdown = async (): Promise<void> => {
        const failures: unknown[] = [];
        if (metricsRegistered) {
            metrics.disable();
            metricsRegistered = false;
        }
        if (traceRegistered) {
            trace.disable();
            traceRegistered = false;
        }
        if (contextRegistered) {
            context.disable();
            contextRegistered = false;
        }
        for (const owner of [metricProvider, traceProvider]) {
            if (owner === null) continue;
            try {
                await owner.shutdown();
            } catch (cause) {
                failures.push(cause);
            }
        }
        metricProvider = null;
        traceProvider = null;
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) throw new AggregateError(failures, "observability shutdown failed");
    };

    try {
        if (selection.traces.length > 0) {
            const [traceSdk, { AsyncLocalStorageContextManager }] = await Promise.all([
                import("@opentelemetry/sdk-trace-base"),
                import("@opentelemetry/context-async-hooks"),
            ]);
            const processors = await Promise.all(selection.traces.map(async (name) => {
                if (name === "console") {
                    return new traceSdk.SimpleSpanProcessor(new traceSdk.ConsoleSpanExporter());
                }
                const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-http");
                return new traceSdk.BatchSpanProcessor(new OTLPTraceExporter());
            }));
            traceProvider = new traceSdk.BasicTracerProvider({ resource, spanProcessors: processors });
            const contextManager = new AsyncLocalStorageContextManager().enable();
            if (!context.setGlobalContextManager(contextManager)) {
                contextManager.disable();
                throw new Error("observe: an OpenTelemetry context manager is already registered");
            }
            contextRegistered = true;
            if (!trace.setGlobalTracerProvider(traceProvider)) {
                throw new Error("observe: an OpenTelemetry tracer provider is already registered");
            }
            traceRegistered = true;
        }

        if (selection.metrics.length > 0) {
            const metricSdk = await import("@opentelemetry/sdk-metrics");
            const readers = await Promise.all(selection.metrics.map(async (name) => {
                if (name === "console") {
                    return new metricSdk.PeriodicExportingMetricReader({
                        exporter: new metricSdk.ConsoleMetricExporter(),
                    });
                }
                const { OTLPMetricExporter } = await import("@opentelemetry/exporter-metrics-otlp-http");
                return new metricSdk.PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter() });
            }));
            metricProvider = new metricSdk.MeterProvider({ resource, readers });
            if (!metrics.setGlobalMeterProvider(metricProvider)) {
                throw new Error("observe: an OpenTelemetry meter provider is already registered");
            }
            metricsRegistered = true;
        }
    } catch (cause) {
        try {
            await shutdown();
        } catch (shutdownCause) {
            throw new AggregateError([cause, shutdownCause], "observability startup and shutdown failed");
        }
        throw cause;
    }

    let stopped = false;
    const handle: ObservabilityHandle = {
        shutdown: async (): Promise<void> => {
            if (stopped) return;
            stopped = true;
            if (active === handle) active = null;
            await shutdown();
        },
    };
    active = handle;
    return handle;
};

export const startObservability = async (env: Env = process.env): Promise<ObservabilityHandle | null> => {
    if (active !== null) return active;
    if (starting !== null) return starting;
    const selection = select(env);
    if (selection === null) return null;
    starting = initialize(selection);
    try {
        return await starting;
    } finally {
        starting = null;
    }
};
