// The observational boundary's default and configured behavior
// ({§observability-boundary}). Each test file runs in its own process, so the
// one-per-process SDK registration stays isolated here.

import test from "node:test";
import assert from "node:assert/strict";
import { startObservability } from "./init.ts";
import { serviceTracer } from "./api.ts";

test("observe: an unconfigured process keeps the no-op API — no SDK loads and spans do not record", async () => {
    const handle = await startObservability({});
    assert.equal(handle, null, "no exporter named → no SDK handle");
    const span = serviceTracer().startSpan("probe");
    assert.equal(span.isRecording(), false, "without a registered SDK, spans are no-ops");
    span.end();
});

test("observe: OTEL_SDK_DISABLED keeps the no-op API even with exporters named", async () => {
    const handle = await startObservability({ OTEL_SDK_DISABLED: "true", OTEL_TRACES_EXPORTER: "console" });
    assert.equal(handle, null);
    const span = serviceTracer().startSpan("probe");
    assert.equal(span.isRecording(), false);
    span.end();
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
