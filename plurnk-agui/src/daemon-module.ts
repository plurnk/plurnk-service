// {§agui-daemon-client} {§module-self-activation} — this package's daemon module entry ({§module-discovery}):
// the client interface reads its settings from the assembled environment.
import Module from "./Module.ts";

export default (): Module => Module.create();
