import Module from "./Module.ts";
import { resolveModuleOptions } from "./config.ts";

export default (): Module => Module.create(resolveModuleOptions());
