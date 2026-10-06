// {§a2a-module} {§module-self-activation} — this package's daemon module entry ({§module-discovery}):
// the outbound family and, when its settings select it, the inbound exposure.
import Module from "./Module.ts";

export default (): Module => Module.init();
