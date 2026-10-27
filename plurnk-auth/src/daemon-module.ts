// {§auth-daemon-module} {§module-self-activation} — this package's daemon module entry ({§module-lifecycle}):
// the authorization server reads its settings from the assembled environment.
import Module from "./Module.ts";

export default (): Module => Module.create();
