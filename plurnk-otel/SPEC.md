# Plurnk OpenTelemetry module specification

`@plurnk/plurnk-otel` is the daemon's OpenTelemetry SDK owner: a discovered module ({§module-discovery} in the core
specification) that registers the trace and metric providers the standard `OTEL_*` environment selects. The daemon and
every reusable package instrument themselves on the OpenTelemetry API alone ({§observability-boundary}); what they
record and never record is that boundary's rule, and this module only gives those API calls a provider.

## Registration

<!-- map -->
| Tag | Promise |
| --- | --- |
| {§otel-module} | **The module registers at `setup` exactly the providers `OTEL_*` selects, and nothing when none is.** It… |
| {§otel-contained} | An unsupported exporter name is contained. |
| {§otel-shutdown} | `stop` releases every global it registered and shuts every provider down, keeping every failure. |
<!-- /map -->

§otel-module **The module registers at `setup` exactly the providers `OTEL_*` selects, and nothing when none is.** It reads its configuration as its factory constructs it ({§module-self-activation}), before any SDK or exporter module loads; an unconfigured or disabled process loads no implementation and keeps the API's no-op behaviour. At `setup` it constructs the selected exporters and providers under the configured resource and registers them as the process's global tracer provider, meter provider and context manager; a global another owner already registered fails `setup`, and with it boot ({§module-failure}). Spans begun before its `setup` — the listener bind, the database open, the modules that set up before it — are the API's no-ops.

| Variable | Effect |
| --- | --- |
| `OTEL_TRACES_EXPORTER` / `OTEL_METRICS_EXPORTER` | select `otlp` or `console` per signal, several comma-separated; a missing or `none` value keeps that signal off, and no SDK default selects an exporter |
| `OTEL_SERVICE_NAME` | names the service resource; absent or blank, `plurnk-service` |
| `OTEL_SDK_DISABLED` | case-insensitive `true` registers nothing, whatever else is set |
| `OTEL_EXPORTER_OTLP_*` | honored by the OTLP exporters |

A traces-only selection registers no meter provider and a metrics-only selection no tracer provider; OTel Logs have no provider or initialization path here.

§otel-contained **An unsupported exporter name is contained.** An `OTEL_TRACES_EXPORTER` or `OTEL_METRICS_EXPORTER` value that is neither `otlp`, `console` nor `none` is a contained configuration ({§module-contained-configuration}) naming the variable: the module registers nothing, the daemon boots and reports the diagnostic as `module:@plurnk/plurnk-otel` ({§configuration-repair-path}), and the offline check fails.

§otel-shutdown **`stop` releases every global it registered and shuts every provider down, keeping every failure.** The meter provider, tracer provider and context manager are released in that order and each provider's shutdown awaited; one failure is thrown as itself, several as one `AggregateError`. A registration that fails midway is unwound the same way before its cause is thrown. A second `stop` is a no-op.
