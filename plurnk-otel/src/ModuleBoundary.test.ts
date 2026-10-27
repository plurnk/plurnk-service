import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// The implementation modules a child process loads for one configuration, from construction through stop: every module
// it resolves, imported or required.
const implementationModules = async (env: Record<string, string>): Promise<string[]> => {
    const source = `
        import { registerHooks } from "node:module";
        const resolved = [];
        registerHooks({ resolve(specifier, context, nextResolve) {
            const result = nextResolve(specifier, context);
            resolved.push(result.url);
            return result;
        } });
        const { default: Module } = await import(${JSON.stringify(new URL("./Module.ts", import.meta.url).href)});
        const module = Module.init(${JSON.stringify(env)});
        await module.setup();
        const loaded = [...new Set(resolved)].filter((url) =>
            /node_modules\\/@opentelemetry\\/(?:context-async-hooks|exporter-|resources|sdk-)/.test(url)
        );
        process.stdout.write(JSON.stringify(loaded));
        await module.stop();
    `;
    const { stdout } = await execFileAsync(process.execPath, [
        "--conditions=plurnk-dev",
        "--experimental-strip-types",
        "--input-type=module",
        "--eval",
        source,
    ]);
    return JSON.parse(stdout) as string[];
};

test("{§otel-module} unconfigured and standards-valid disabled processes load no implementation modules", async () => {
    const [unconfigured, disabled] = await Promise.all([
        implementationModules({}),
        implementationModules({ OTEL_SDK_DISABLED: "True", OTEL_TRACES_EXPORTER: "console" }),
    ]);
    assert.deepEqual(unconfigured, []);
    assert.deepEqual(disabled, []);
});

test("{§otel-module} configured traces load their selected SDK without a NodeSDK or Logs path", async () => {
    const loaded = await implementationModules({ OTEL_TRACES_EXPORTER: "console" });
    assert.ok(loaded.some((path) => path.includes("@opentelemetry/sdk-trace")));
    assert.ok(!loaded.some((path) => /@opentelemetry\/(?:sdk-node|sdk-logs|exporter-logs-)/.test(path)));
});

test("{§otel-module} each OTLP signal loads its selected exporter without a NodeSDK or Logs provider", async () => {
    const [traces, metricsOnly] = await Promise.all([
        implementationModules({ OTEL_TRACES_EXPORTER: "otlp" }),
        implementationModules({ OTEL_METRICS_EXPORTER: "otlp" }),
    ]);
    assert.ok(traces.some((path) => path.includes("exporter-trace-otlp-http")));
    assert.ok(!traces.some((path) => /@opentelemetry\/(?:sdk-node|sdk-logs|exporter-logs-)/.test(path)));

    assert.ok(metricsOnly.some((path) => path.includes("exporter-metrics-otlp-http")));
    assert.ok(!metricsOnly.some((path) => /@opentelemetry\/(?:sdk-node|sdk-logs|exporter-logs-)/.test(path)));
});
