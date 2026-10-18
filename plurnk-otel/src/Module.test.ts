// {§otel-module} {§otel-contained} {§otel-shutdown} — the module's default and configured behaviour. Each test file runs
// in its own process, so the one-per-process SDK registration stays isolated here.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { trace, metrics } from "@opentelemetry/api";
import Module from "./Module.ts";

const tracer = () => trace.getTracer("plurnk.service");

// The implementation modules a child process loads for one configuration, from construction through stop.
const implementationModules = (env: Record<string, string>): string[] => {
    const source = `
        import { createRequire } from "node:module";
        const require = createRequire(import.meta.url);
        const { default: Module } = await import(${JSON.stringify(new URL("./Module.ts", import.meta.url).href)});
        const module = Module.init(${JSON.stringify(env)});
        await module.setup();
        const loaded = Object.keys(require.cache).filter((path) =>
            /node_modules\\/@opentelemetry\\/(?:context-async-hooks|exporter-|resources|sdk-)/.test(path)
        );
        process.stdout.write(JSON.stringify(loaded));
        await module.stop();
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

const quietly = async <T>(body: () => Promise<T>): Promise<T> => {
    const dir = console.dir.bind(console);
    console.dir = (): void => {};
    try { return await body(); } finally { console.dir = dir; }
};

test("{§otel-module} an unconfigured module registers nothing: no SDK loads and spans do not record", async () => {
    const module = Module.init({});
    assert.equal(module.selection, null, "no exporter named → nothing to register");
    await module.setup();
    assert.equal(module.registered, false);
    const span = tracer().startSpan("probe");
    assert.equal(span.isRecording(), false, "without a registered SDK, spans are the API's no-ops");
    span.end();
    await module.stop();
});

test("{§otel-module} OTEL_SDK_DISABLED keeps the no-op API even with exporters named", async () => {
    const module = Module.init({ OTEL_SDK_DISABLED: "TRUE", OTEL_TRACES_EXPORTER: "console" });
    assert.equal(module.selection, null);
    await module.setup();
    assert.equal(tracer().startSpan("probe").isRecording(), false);
});

test("{§otel-module} unconfigured and standards-valid disabled processes load no implementation modules", () => {
    assert.deepEqual(implementationModules({}), []);
    assert.deepEqual(implementationModules({ OTEL_SDK_DISABLED: "True", OTEL_TRACES_EXPORTER: "console" }), []);
});

test("{§otel-module} configured traces load their selected SDK without a NodeSDK or Logs path", () => {
    const loaded = implementationModules({ OTEL_TRACES_EXPORTER: "console" });
    assert.ok(loaded.some((path) => path.includes("@opentelemetry/sdk-trace")));
    assert.ok(!loaded.some((path) => /@opentelemetry\/(?:sdk-node|sdk-logs|exporter-logs-)/.test(path)));
});

test("{§otel-module} each OTLP signal loads its selected exporter without a NodeSDK or Logs provider", () => {
    const traces = implementationModules({ OTEL_TRACES_EXPORTER: "otlp" });
    assert.ok(traces.some((path) => path.includes("exporter-trace-otlp-http")));
    assert.ok(!traces.some((path) => /@opentelemetry\/(?:sdk-node|sdk-logs|exporter-logs-)/.test(path)));

    const metricsOnly = implementationModules({ OTEL_METRICS_EXPORTER: "otlp" });
    assert.ok(metricsOnly.some((path) => path.includes("exporter-metrics-otlp-http")));
    assert.ok(!metricsOnly.some((path) => /@opentelemetry\/(?:sdk-node|sdk-logs|exporter-logs-)/.test(path)));
});

test("{§otel-module} exporter names `none` select nothing", () => {
    assert.equal(Module.init({ OTEL_TRACES_EXPORTER: "none", OTEL_METRICS_EXPORTER: "none" }).selection, null);
});

test("{§otel-contained} an unsupported exporter name is contained, names its variable, and registers nothing", async () => {
    const module = Module.init({ OTEL_TRACES_EXPORTER: "otlp,jager" });
    assert.equal(module.contained?.length, 1);
    assert.equal(module.contained?.[0].key, "OTEL_TRACES_EXPORTER");
    assert.match(module.contained?.[0].message ?? "", /unsupported OTEL_TRACES_EXPORTER value "jager"/);
    assert.equal(module.selection, null);
    await module.setup();
    assert.equal(module.registered, false);
    assert.equal(tracer().startSpan("probe").isRecording(), false);
});

test("{§otel-module} a configured console trace exporter registers a recording provider that exports spans under the service name", async () => {
    const module = Module.init({ OTEL_TRACES_EXPORTER: "console", OTEL_METRICS_EXPORTER: "none", OTEL_SERVICE_NAME: "otel-test" });
    assert.deepEqual(module.selection, { traces: ["console"], metrics: [], serviceName: "otel-test" });
    // ConsoleSpanExporter emits through console.dir; capture the synchronous SimpleSpanProcessor export around the span.
    const printed: string[] = [];
    const dir = console.dir.bind(console);
    console.dir = (obj: unknown): void => { printed.push(JSON.stringify(obj)); };
    try {
        await module.setup();
        assert.equal(module.registered, true);
        const span = tracer().startSpan("otel-probe-span");
        assert.equal(span.isRecording(), true, "the registered tracer records");
        span.end();
        await new Promise((resolve) => setTimeout(resolve, 10));
        assert.ok(printed.join("\n").includes('"otel-probe-span"'), "the exported span reaches the configured console exporter");
        assert.ok(printed.join("\n").includes('"otel-test"'), "the service name resource is exported");
    } finally {
        console.dir = dir;
        await module.stop();
    }
    // {§otel-shutdown} Stopped: the globals are released and spans are no-ops again; a second stop is a no-op.
    assert.equal(module.registered, false);
    assert.equal(tracer().startSpan("after").isRecording(), false, "stop released the tracer provider");
    await module.stop();
});

test("{§otel-module} an empty OTEL_SERVICE_NAME uses the daemon's service name", async () => {
    const module = Module.init({ OTEL_TRACES_EXPORTER: "console", OTEL_SERVICE_NAME: "  " });
    assert.equal(module.selection?.serviceName, "plurnk-service");
    const printed: string[] = [];
    const dir = console.dir.bind(console);
    console.dir = (obj: unknown): void => { printed.push(JSON.stringify(obj)); };
    try {
        await module.setup();
        tracer().startSpan("default-service-name").end();
        await new Promise((resolve) => setTimeout(resolve, 10));
        assert.ok(printed.join("\n").includes('"plurnk-service"'));
    } finally {
        console.dir = dir;
        await module.stop();
    }
});

test("{§otel-module} a traces-only selection never registers a meter provider", async () => {
    const module = Module.init({ OTEL_TRACES_EXPORTER: "console", OTEL_METRICS_EXPORTER: "none" });
    await quietly(async () => {
        await module.setup();
        try {
            assert.equal(tracer().startSpan("probe").isRecording(), true, "the SDK replaced the no-op tracer provider");
            assert.equal(metrics.getMeterProvider().constructor.name, "NoopMeterProvider", "no metric reader was configured");
        } finally {
            await module.stop();
        }
    });
});

test("{§otel-module} a metrics-only selection registers no tracer provider", async () => {
    const module = Module.init({ OTEL_TRACES_EXPORTER: "none", OTEL_METRICS_EXPORTER: "console" });
    await module.setup();
    try {
        assert.equal(tracer().startSpan("probe").isRecording(), false);
        assert.equal(metrics.getMeterProvider().constructor.name, "MeterProvider");
    } finally {
        await module.stop();
    }
});

test("{§otel-module} a setup that finds a provider another owner registered fails, and leaves nothing behind", async () => {
    const first = Module.init({ OTEL_TRACES_EXPORTER: "console" });
    const second = Module.init({ OTEL_TRACES_EXPORTER: "console" });
    await quietly(async () => {
        await first.setup();
        try {
            await assert.rejects(second.setup(), /already registered/);
            assert.equal(second.registered, false);
            assert.equal(tracer().startSpan("still").isRecording(), true, "the first owner's registration stands");
        } finally {
            await first.stop();
        }
    });
});
