# Plurnk OpenTelemetry module specification

`@plurnk/plurnk-otel` is the daemon's OpenTelemetry SDK owner: a discovered module ({§module-lifecycle}) that registers the trace and metric providers selected by standard `OTEL_*` variables for packages instrumented on the OpenTelemetry API ({§observability-boundary}).

## §otel-module 1. OpenTelemetry Provider Registration, Containment, and Shutdown

The module reads configuration in its factory ({§module-contract}) before loading any SDK or exporter module; when unconfigured or disabled, it loads no implementation and leaves the API's no-op behavior in place. At `setup` it constructs the selected exporters and providers under the configured resource and registers global tracer provider, meter provider, and context manager (failing `setup` and boot if another owner already registered a global).

| Variable / Lifecycle | Contract |
| --- | --- |
| `OTEL_TRACES_EXPORTER` / `OTEL_METRICS_EXPORTER` | Comma-separated `otlp` or `console` per signal; missing or `none` keeps that signal off (traces-only registers no meter provider; metrics-only registers no tracer provider; OTel Logs have no provider here). Any other value is contained ({§module-contract}) naming the variable (`module:@plurnk/plurnk-otel`, {§configuration-repair-path}), registering nothing and failing offline checks. |
| `OTEL_SERVICE_NAME` | Service resource name; defaults to `plurnk-service` when absent or blank. |
| `OTEL_SDK_DISABLED` | Case-insensitive `true` registers nothing regardless of other variables. |
| `OTEL_EXPORTER_OTLP_*` | Honored by the OTLP exporters. |
| `stop` & unwind | Releases global meter provider, tracer provider, and context manager in that order and awaits each provider's shutdown (unwinding partial registrations the same way on midway failure); throws a single failure as itself or multiple as `AggregateError`. A second `stop` is a no-op. |
