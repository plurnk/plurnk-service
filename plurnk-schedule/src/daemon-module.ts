// {§schedule-module} {§module-self-activation} — this package's daemon module entry
// ({§module-discovery}): the family reads its own configuration from the environment.
import Module from "./Module.ts";

export default (): Module => Module.init();
