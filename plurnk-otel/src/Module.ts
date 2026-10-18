// {§otel-module} The one owner of the OpenTelemetry SDK. The daemon and every reusable package instrument themselves on
// the OpenTelemetry API alone ({§observability-boundary} in the core specification); this module gives those calls a
// provider: at `setup` it registers exactly what `OTEL_*` selects, at `stop` it releases it. Configuration is read as the
// factory constructs the module, before any SDK or exporter module loads.

import type {
    MeterProvider as ApiMeterProvider,
    TracerProvider as ApiTracerProvider,
} from "@opentelemetry/api";
import { ConfigurationError } from "@plurnk/plurnk-meta";
import type { ContainedConfiguration, DaemonModule, ModuleSetupSeam } from "@plurnk/plurnk-modules";

export const SERVICE_NAME = "plurnk-service";

type Env = Record<string, string | undefined>;
type SignalName = "OTEL_TRACES_EXPORTER" | "OTEL_METRICS_EXPORTER";
type ExporterName = "otlp" | "console";
type ShutdownOwner = { shutdown(): Promise<void> };
type TraceProviderOwner = ApiTracerProvider & ShutdownOwner;
type MetricProviderOwner = ApiMeterProvider & ShutdownOwner;

export interface Selection {
    readonly traces: readonly ExporterName[];
    readonly metrics: readonly ExporterName[];
    readonly serviceName: string;
}

interface Registration {
    shutdown(): Promise<void>;
}

const exporterNames = (value: string | undefined): string[] => [
    ...new Set((value ?? "")
        .split(",")
        .map((name) => name.trim().toLowerCase())
        .filter((name) => name.length > 0 && name !== "none")),
];

// {§otel-contained} A name that is neither `otlp`, `console` nor `none` is a configuration error naming its variable.
const selectExporters = (env: Env, signal: SignalName): ExporterName[] => exporterNames(env[signal]).map((name) => {
    if (name === "otlp" || name === "console") return name;
    throw new ConfigurationError(signal,
        `otel: unsupported ${signal} value ${JSON.stringify(name)} (supported: otlp, console)`,
    );
});

// {§otel-module} What `OTEL_*` selects: null when nothing is, or the SDK is disabled.
export const select = (env: Env): Selection | null => {
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

// {§otel-module} Construct the selected exporters and providers and register them as the process's globals; a global
// another owner already holds fails the registration, which is unwound ({§otel-shutdown}) before its cause is thrown.
const register = async (selection: Selection): Promise<Registration> => {
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

    // {§otel-shutdown} Release every registered global, then join every provider's shutdown, keeping every failure.
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
        if (failures.length > 1) throw new AggregateError(failures, "otel: shutdown failed");
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
                throw new Error("otel: an OpenTelemetry context manager is already registered");
            }
            contextRegistered = true;
            if (!trace.setGlobalTracerProvider(traceProvider)) {
                throw new Error("otel: an OpenTelemetry tracer provider is already registered");
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
                throw new Error("otel: an OpenTelemetry meter provider is already registered");
            }
            metricsRegistered = true;
        }
    } catch (cause) {
        try {
            await shutdown();
        } catch (shutdownCause) {
            throw new AggregateError([cause, shutdownCause], "otel: registration and its unwinding failed");
        }
        throw cause;
    }

    return { shutdown };
};

export default class Module implements DaemonModule<ModuleSetupSeam, unknown> {
    // {§module-contained-configuration} An unsupported exporter name, with the module registering nothing.
    readonly contained?: readonly ContainedConfiguration[];
    readonly #selection: Selection | null;
    #registration: Registration | null = null;

    // {§module-self-activation} {§otel-contained} The factory reads `OTEL_*`; an unsupported name is contained, not thrown.
    static init(env: Env = process.env): Module {
        try {
            return new Module(select(env));
        } catch (cause) {
            if (cause instanceof ConfigurationError) return new Module(null, [{ key: cause.key, message: cause.message }]);
            throw cause;
        }
    }

    private constructor(selection: Selection | null, contained?: readonly ContainedConfiguration[]) {
        this.#selection = selection;
        if (contained !== undefined) this.contained = contained;
    }

    /** What this module will register at `setup`: null when nothing. */
    get selection(): Selection | null { return this.#selection; }

    /** Whether the providers are registered now. */
    get registered(): boolean { return this.#registration !== null; }

    // {§otel-module} Registration happens once, at setup; an unconfigured module registers nothing.
    async setup(): Promise<void> {
        if (this.#selection === null || this.#registration !== null) return;
        this.#registration = await register(this.#selection);
    }

    // {§otel-shutdown} Stopping releases the globals and shuts the providers down; a second stop is a no-op.
    async stop(): Promise<void> {
        const registration = this.#registration;
        this.#registration = null;
        if (registration !== null) await registration.shutdown();
    }
}
