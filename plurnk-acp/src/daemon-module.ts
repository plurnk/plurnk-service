import Module from "./Module.ts";
import { resolveModuleOptions } from "./config.ts";

export const createDaemonModule = (): Module => Module.create(resolveModuleOptions());
export default createDaemonModule;
