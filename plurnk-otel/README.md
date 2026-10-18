# @plurnk/plurnk-otel

The Plurnk daemon's OpenTelemetry SDK, as a module. The daemon instruments itself on the OpenTelemetry
API alone; this package registers the trace and metric providers the standard `OTEL_*` environment
selects, and registers nothing when none is. It ships with the default installation and is inert
until configured.

```sh
OTEL_TRACES_EXPORTER=otlp OTEL_METRICS_EXPORTER=otlp OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 plurnk-service start
OTEL_TRACES_EXPORTER=console plurnk-service start     # spans on stderr
```

| Variable | Values |
|---|---|
| `OTEL_TRACES_EXPORTER`, `OTEL_METRICS_EXPORTER` | `otlp`, `console`, `none` (several, comma-separated) |
| `OTEL_SERVICE_NAME` | the service resource name; default `plurnk-service` |
| `OTEL_SDK_DISABLED` | `true` registers nothing |
| `OTEL_EXPORTER_OTLP_*` | the OTLP exporters' own settings |

An unsupported exporter name is reported as a configuration diagnostic owned by `module:@plurnk/plurnk-otel`; the
daemon boots without telemetry. The contract is `SPEC.md`; what the daemon records is the core specification's
observability boundary.
