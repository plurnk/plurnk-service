---
"@plurnk/plurnk-otel": major
"@plurnk/plurnk-service": minor
---

The OpenTelemetry SDK registration is the new `@plurnk/plurnk-otel` module
(#1167): it registers the trace and metric providers `OTEL_*` selects at
module setup and releases them at stop, on OpenTelemetry JS 3
(`@opentelemetry/sdk-trace`, API 1.10), and ships with the default
installation. The service keeps only the OpenTelemetry API and sheds six SDK
packages; an unsupported exporter name is now reported as that module's
contained configuration (`module:@plurnk/plurnk-otel`).
