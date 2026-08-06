// The observational boundary's default and configured behavior
// ({§observability-boundary}). Each test file runs in its own process, so the
// one-per-process SDK registration stays isolated here.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { startObservability } from "./init.ts";
import { serviceTracer } from "./api.ts";

const implementationModules = (env: Record<string, string>): string[] => {
    const source = `
        import { createRequire } from "node:module";
        const require = createRequire(import.meta.url);
        const { startObservability } = await import(${JSON.stringify(new URL("./init.ts", import.meta.url).href)});
        const handle = await startObservability(${JSON.stringify(env)});
        const loaded = Object.keys(require.cache).filter((path) =>
            /node_modules\\/@opentelemetry\\/(?:context-async-hooks|exporter-|resources|sdk-)/.test(path)
        );
        process.stdout.write(JSON.stringify(loaded));
        await handle?.shutdown();
    `;
    const result = spawnSync(process.execPath, [
        "--conditions=plurnk-dev",
        "--experimental-strip-types",
        "--input-type=module",
        "--eval",
        source,
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, `module-boundary child failed: ${result.stderr}`);
    return JSON.parse(result.stdout) as string[];
};

test("observe: an unconfigured process keeps the no-op API — no SDK loads and spans do not record", async () => {
    const handle = await startObservability({});
    assert.equal(handle, null, "no exporter named → no SDK handle");
    const span = serviceTracer().startSpan("probe");
    assert.equal(span.isRecording(), false, "without a registered SDK, spans are no-ops");
    span.end();
});

test("observe: OTEL_SDK_DISABLED keeps the no-op API even with exporters named", async () => {
    const handle = await startObservability({ OTEL_SDK_DISABLED: "TRUE", OTEL_TRACES_EXPORTER: "console" });
    assert.equal(handle, null);
    const span = serviceTracer().startSpan("probe");
    assert.equal(span.isRecording(), false);
    span.end();
});

test("observe: unconfigured and standards-valid disabled processes load no implementation modules", () => {
    assert.deepEqual(implementationModules({}), []);
    assert.deepEqual(implementationModules({ OTEL_SDK_DISABLED: "True", OTEL_TRACES_EXPORTER: "console" }), []);
});

test("observe: configured traces load their selected SDK without a NodeSDK or Logs path", () => {
    const loaded = implementationModules({ OTEL_TRACES_EXPORTER: "console" });
    assert.ok(loaded.some((path) => path.includes("@opentelemetry/sdk-trace")));
    assert.ok(!loaded.some((path) => /@opentelemetry\/(?:sdk-node|sdk-logs|exporter-logs-)/.test(path)));
});

test("observe: each OTLP signal loads its selected exporter without a NodeSDK or Logs provider", () => {
    const traces = implementationModules({ OTEL_TRACES_EXPORTER: "otlp" });
    assert.ok(traces.some((path) => path.includes("exporter-trace-otlp-http")));
    assert.ok(!traces.some((path) => /@opentelemetry\/(?:sdk-node|sdk-logs|exporter-logs-)/.test(path)));

    const metrics = implementationModules({ OTEL_METRICS_EXPORTER: "otlp" });
    assert.ok(metrics.some((path) => path.includes("exporter-metrics-otlp-http")));
    assert.ok(!metrics.some((path) => /@opentelemetry\/(?:sdk-node|sdk-logs|exporter-logs-)/.test(path)));
});

test("observe: exporter names `none` do not load the SDK", async () => {
    const handle = await startObservability({ OTEL_TRACES_EXPORTER: "none", OTEL_METRICS_EXPORTER: "none" });
    assert.equal(handle, null);
});

test("observe: unknown exporter names fail at boot instead of silently disabling observation", async () => {
    await assert.rejects(
        startObservability({ OTEL_TRACES_EXPORTER: "otlp,jager" }),
        /unsupported OTEL_TRACES_EXPORTER value "jager"/,
    );
});

test("observe: a configured console trace exporter registers a recording provider that exports spans", async () => {
    const handle = await startObservability({ OTEL_TRACES_EXPORTER: "console", OTEL_METRICS_EXPORTER: "none", OTEL_SERVICE_NAME: "observe-test" });
    if (handle === null) throw new Error("console traces configured — expected an SDK handle");
    const shutdown = handle.shutdown.bind(handle);
    // ConsoleSpanExporter emits through console.dir; capture the synchronous
    // SimpleSpanProcessor export around the span's life.
    const printed: string[] = [];
    const dir = console.dir.bind(console);
    console.dir = (obj: unknown): void => { printed.push(JSON.stringify(obj)); };
    try {
        const span = serviceTracer().startSpan("observe-probe-span");
        try {
            assert.equal(span.isRecording(), true, "the registered tracer records");
        } finally {
            span.end(); // SimpleSpanProcessor exports after async resource resolution
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
        assert.ok(
            printed.join("\n").includes('"observe-probe-span"'),
            "the exported span reaches the configured console exporter",
        );
        assert.ok(printed.join("\n").includes('"observe-test"'), "the service name resource is exported");
    } finally {
        console.dir = dir;
        await shutdown();
    }
});

test("observe: an empty OTEL_SERVICE_NAME uses the daemon service name", async () => {
    const handle = await startObservability({ OTEL_TRACES_EXPORTER: "console", OTEL_SERVICE_NAME: "  " });
    if (handle === null) throw new Error("console traces configured — expected an SDK handle");
    const printed: string[] = [];
    const dir = console.dir.bind(console);
    console.dir = (obj: unknown): void => { printed.push(JSON.stringify(obj)); };
    try {
        const span = serviceTracer().startSpan("default-service-name");
        span.end();
        await new Promise((resolve) => setTimeout(resolve, 10));
        assert.ok(printed.join("\n").includes('"plurnk-service"'));
    } finally {
        console.dir = dir;
        await handle.shutdown();
    }
});

test("observe: traces-only configuration never registers a meter provider", async () => {
    const dir = console.dir.bind(console);
    console.dir = (): void => {};
    const handle = await startObservability({ OTEL_TRACES_EXPORTER: "console", OTEL_METRICS_EXPORTER: "none" });
    if (handle === null) throw new Error("console traces configured — expected an SDK handle");
    const shutdown = handle.shutdown.bind(handle);
    try {
        assert.equal(
            serviceTracer().startSpan("probe").isRecording(),
            true,
            "the SDK replaced the no-op tracer provider — spans record again",
        );
        assert.equal(
            (await import("@opentelemetry/api")).metrics.getMeterProvider().constructor.name,
            "NoopMeterProvider",
            "no metric reader was configured → the meter provider stays a no-op",
        );
    } finally {
        console.dir = dir;
        await shutdown();
    }
});

test("observe: metrics-only configuration registers no tracer provider", async () => {
    const handle = await startObservability({ OTEL_TRACES_EXPORTER: "none", OTEL_METRICS_EXPORTER: "console" });
    if (handle === null) throw new Error("console metrics configured — expected an observability handle");
    const shutdown = handle.shutdown.bind(handle);
    try {
        assert.equal(serviceTracer().startSpan("probe").isRecording(), false);
        assert.equal(
            (await import("@opentelemetry/api")).metrics.getMeterProvider().constructor.name,
            "MeterProvider",
        );
    } finally {
        await shutdown();
    }
});
