// {§hooks-module} {§module-contract} — this package's daemon module entry ({§module-lifecycle}):
// the module reads its own configuration and stays inert without it.
import Module from "./Module.ts";

export default (): Module => Module.init();
