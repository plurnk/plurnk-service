// {§otel-module} {§module-contract} — this package's daemon module entry ({§module-lifecycle}): the module reads
// `OTEL_*` itself, before any SDK or exporter loads.
import Module from "./Module.ts";

export default (): Module => Module.init();
