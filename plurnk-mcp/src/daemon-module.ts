// {§mcp-module} {§module-contract} — this package's daemon module entry ({§module-lifecycle}):
// a setup-only module that reads its own configuration from the environment.
import Module from "./Module.ts";

export default (): Module => Module.init();
