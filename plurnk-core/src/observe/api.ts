// The OTel API acquisition side of the observational boundary
// ({§observability-boundary}). Everything outside init.ts depends only on
// @opentelemetry/api; the SDK loads only when a daemon explicitly initializes
// it. An unregistered process keeps the API's no-op behavior — the default
// cost of instrumented code is bounded to the no-op calls themselves.

import { metrics, trace, type Meter, type Tracer } from "@opentelemetry/api";

export const TRACER_NAME = "plurnk.service";
export const METER_NAME = "plurnk.service";

export const serviceTracer = (): Tracer => trace.getTracer(TRACER_NAME);
export const serviceMeter = (): Meter => metrics.getMeter(METER_NAME);
