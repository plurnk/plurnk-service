// {§hooks-module} {§module-self-activation} — this package's daemon module entry ({§module-discovery}):
// the module reads its own configuration and stays inert without it.
import Module from "./Module.ts";

export default (): Module => Module.init();
